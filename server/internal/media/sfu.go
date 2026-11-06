// SPDX-License-Identifier: AGPL-3.0-only
package media

import (
	"context"
	"errors"
	"io"
	"net"
	"net/netip"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/interceptor"
	"github.com/pion/interceptor/pkg/cc"
	"github.com/pion/interceptor/pkg/gcc"
	"github.com/pion/interceptor/pkg/nack"
	"github.com/pion/logging"
	"github.com/pion/webrtc/v4"
)

type AdmissionAuthority interface {
	Send(context.Context, Control) (AdmissionPolicy, error)
}
type SFUConfig struct {
	PublicIP, UDPAddr, TCPAddr string
	Authority                  AdmissionAuthority
	// Loopback is only for in-process fixtures, never enabled from the environment.
	AllowLoopback bool
	TURN          *TURNConfig
}

type SFU struct {
	cfg        SFUConfig
	mu         sync.Mutex
	rooms      map[string]*room
	peers      map[string]*mediaPeer
	users      map[string]*mediaPeer
	udp        net.PacketConn
	tcp        net.Listener
	udpMux     ice.UDPMux
	tcpMux     ice.TCPMux
	turn       *turnRuntime
	generation atomic.Int64
	closed     bool
}

func NewSFU(c SFUConfig) (*SFU, error) {
	ip, err := netip.ParseAddr(c.PublicIP)
	ip = ip.Unmap()
	if err != nil || ip.IsUnspecified() || ip.IsMulticast() || ip.IsLinkLocalUnicast() || (!c.AllowLoopback && ip.IsLoopback()) || c.Authority == nil {
		return nil, errors.New("invalid media networking or authorization configuration")
	}
	c.PublicIP = ip.String()
	if c.UDPAddr == "" {
		c.UDPAddr = ":7882"
	}
	if c.TCPAddr == "" {
		c.TCPAddr = ":7881"
	}
	var listen net.ListenConfig
	udp, err := listen.ListenPacket(context.Background(), "udp", c.UDPAddr)
	if err != nil {
		return nil, errors.New("cannot bind media UDP listener")
	}
	tcp, err := listen.Listen(context.Background(), "tcp", c.TCPAddr)
	if err != nil {
		_ = udp.Close()
		return nil, errors.New("cannot bind media TCP listener")
	}
	tcp = limitListener(tcp)
	e := &SFU{cfg: c, rooms: map[string]*room{}, peers: map[string]*mediaPeer{}, users: map[string]*mediaPeer{}, udp: udp, tcp: tcp}
	e.udpMux = ice.NewUDPMuxDefault(ice.UDPMuxParams{UDPConn: udp, Logger: mediaLogger.NewLogger("ice-udp")})
	e.tcpMux = ice.NewTCPMuxDefault(ice.TCPMuxParams{Listener: tcp, ReadBufferSize: 8, WriteBufferSize: 64 << 10, FirstStunBindTimeout: 5 * time.Second, AliveDurationForConnFromStun: 5 * time.Second, Logger: mediaLogger.NewLogger("ice-tcp")})
	if c.TURN != nil {
		if err := e.startTURN(*c.TURN); err != nil {
			_ = e.Close()
			return nil, err
		}
	}
	return e, nil
}

func (e *SFU) settings() webrtc.SettingEngine {
	var settings webrtc.SettingEngine
	settings.SetICEUDPMux(e.udpMux)
	settings.SetICETCPMux(e.tcpMux)
	// Host candidates carry the operator's public address (the former NAT 1:1 setting).
	// It fails only together with SetNAT1To1IPs, which is not used.
	_ = settings.SetICEAddressRewriteRules(webrtc.ICEAddressRewriteRule{
		External:        []string{e.cfg.PublicIP},
		AsCandidateType: webrtc.ICECandidateTypeHost,
		Mode:            webrtc.ICEAddressRewriteReplace,
	})
	settings.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	settings.SetIncludeLoopbackCandidate(e.cfg.AllowLoopback)
	ip, _ := netip.ParseAddr(e.cfg.PublicIP)
	if ip.Is4() {
		settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4, webrtc.NetworkTypeTCP4})
	} else {
		settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP6, webrtc.NetworkTypeTCP6})
	}
	settings.SetReceiveMTU(1500)
	settings.SetICETimeouts(5*time.Second, 15*time.Second, 2*time.Second)
	settings.SetICEMaxBindingRequests(16)
	settings.LoggerFactory = mediaLogger
	return settings
}

func (e *SFU) Open(ctx context.Context, g Grant, send func(Signal) error) (SignalPeer, error) {
	generation := e.generation.Add(1)
	// Unix time is not an identity. A monotonically increasing generation is
	// scoped to the node lease, so a replaced transport cannot eject its successor.
	control := Control{Grant: g, Action: "authorize", TransportGeneration: generation}
	policy, err := e.cfg.Authority.Send(ctx, control)
	if err != nil {
		return nil, ErrAdmission
	}
	e.mu.Lock()
	if e.closed {
		e.mu.Unlock()
		return nil, ErrAdmission
	}
	old := e.peers[g.ParticipantID]
	if owner := e.users[g.UserID]; owner != nil && owner.grant.CallID != g.CallID {
		e.mu.Unlock()
		return nil, ErrAdmission
	}
	if old == nil && len(e.peers) >= 128 {
		e.mu.Unlock()
		return nil, ErrAdmission
	}
	r := e.rooms[g.CallID]
	if r == nil {
		if len(e.rooms) >= 32 {
			e.mu.Unlock()
			return nil, ErrAdmission
		}
		r = newRoom(e, g.CallID)
		e.rooms[g.CallID] = r
	}
	r.mu.Lock()
	if old == nil && len(r.peers) >= policy.MaxParticipants {
		r.mu.Unlock()
		e.mu.Unlock()
		return nil, ErrAdmission
	}
	p := newMediaPeer(ctx, e, r, g, policy, generation, send)
	e.peers[g.ParticipantID] = p
	e.users[g.UserID] = p
	r.peers[g.ParticipantID] = p
	r.mu.Unlock()
	e.mu.Unlock()
	if old != nil {
		_ = old.Close()
	}
	if err = p.initialize(); err != nil {
		_ = p.Close()
		return nil, errors.New("cannot initialize media transport")
	}
	r.attachExisting(p)
	return p, nil
}

func (e *SFU) remove(p *mediaPeer) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.peers[p.grant.ParticipantID] == p {
		delete(e.peers, p.grant.ParticipantID)
	}
	if e.users[p.grant.UserID] == p {
		delete(e.users, p.grant.UserID)
	}
	p.room.mu.Lock()
	if p.room.peers[p.grant.ParticipantID] == p {
		delete(p.room.peers, p.grant.ParticipantID)
	}
	empty := len(p.room.peers) == 0
	p.room.mu.Unlock()
	if empty && e.rooms[p.grant.CallID] == p.room {
		delete(e.rooms, p.grant.CallID)
		p.room.cancel()
	}
}
func (e *SFU) Name() string { return "sfu" }
func (e *SFU) Check(ctx context.Context) error {
	e.mu.Lock()
	closed := e.closed
	e.mu.Unlock()
	if closed {
		return errors.New("media engine closed")
	}
	if authority, ok := e.cfg.Authority.(interface{ Check(context.Context) error }); ok {
		return authority.Check(ctx)
	}
	return nil
}

func (e *SFU) Close() error {
	e.mu.Lock()
	e.closed = true
	peers := make([]*mediaPeer, 0, len(e.peers))
	for _, p := range e.peers {
		peers = append(peers, p)
	}
	e.mu.Unlock()
	for _, p := range peers {
		p.cancel()
	}
	for _, p := range peers {
		_ = p.Close()
	}
	if e.turn != nil {
		_ = e.turn.Close()
	}
	_ = e.udpMux.Close()
	_ = e.tcpMux.Close()
	return nil
}

// Only Opus and VP8 are registered. RegisterDefaultCodecs would introduce
// codecs outside this product's permitted media profile.
var mediaLogger = &logging.DefaultLoggerFactory{Writer: io.Discard, DefaultLogLevel: logging.LogLevelDisabled}

func mediaEngine(maxBitrate int, onBitrate func(int)) (*webrtc.MediaEngine, *interceptor.Registry, error) {
	m := &webrtc.MediaEngine{}
	audio := webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2, SDPFmtpLine: "minptime=10;useinbandfec=1;usedtx=1", RTCPFeedback: []webrtc.RTCPFeedback{{Type: "transport-cc"}, {Type: "nack"}}}, PayloadType: 111}
	video := webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000, RTCPFeedback: []webrtc.RTCPFeedback{{Type: "nack"}, {Type: "nack", Parameter: "pli"}, {Type: "ccm", Parameter: "fir"}, {Type: "transport-cc"}}}, PayloadType: 96}
	if err := m.RegisterCodec(audio, webrtc.RTPCodecTypeAudio); err != nil {
		return nil, nil, err
	}
	if err := m.RegisterCodec(video, webrtc.RTPCodecTypeVideo); err != nil {
		return nil, nil, err
	}
	if err := m.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: "urn:ietf:params:rtp-hdrext:ssrc-audio-level"}, webrtc.RTPCodecTypeAudio); err != nil {
		return nil, nil, err
	}
	registry := &interceptor.Registry{}
	congestion, err := cc.NewInterceptor(func() (cc.BandwidthEstimator, error) {
		return gcc.NewSendSideBWE(gcc.SendSideBWEInitialBitrate(min(800000, maxBitrate)), gcc.SendSideBWEMinBitrate(64000), gcc.SendSideBWEMaxBitrate(maxBitrate), gcc.SendSideBWEPacer(gcc.NewNoOpPacer()), gcc.WithLoggerFactory(mediaLogger))
	})
	if err != nil {
		return nil, nil, err
	}
	congestion.OnNewPeerConnection(func(_ string, estimator cc.BandwidthEstimator) {
		onBitrate(estimator.GetTargetBitrate())
		estimator.OnTargetBitrateChange(onBitrate)
	})
	registry.Add(congestion)
	if err := webrtc.RegisterDefaultInterceptorsWithOptions(m, registry, webrtc.WithInterceptorLoggerFactory(mediaLogger), webrtc.WithNackGeneratorOptions(nack.GeneratorSize(128)), webrtc.WithNackResponderOptions(nack.ResponderSize(128))); err != nil {
		return nil, nil, err
	}
	if err := webrtc.ConfigureTWCCHeaderExtensionSender(m, registry); err != nil {
		return nil, nil, err
	}
	return m, registry, nil
}

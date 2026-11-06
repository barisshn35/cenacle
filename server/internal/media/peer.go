// SPDX-License-Identifier: AGPL-3.0-only
package media

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"

	"github.com/pion/webrtc/v4"
)

type tileHint struct {
	Width   int  `json:"width"`
	Height  int  `json:"height"`
	Visible bool `json:"visible"`
}

type mediaPeer struct {
	engine              *SFU
	room                *room
	grant               Grant
	generation          int64
	ctx                 context.Context
	cancel              context.CancelFunc
	send                func(Signal) error
	mu                  sync.Mutex
	pc                  *webrtc.PeerConnection
	publications        map[string]string
	knownTracks         map[string]string
	incomingTracks      int
	iceCount            int
	candidateKeys       map[string]bool
	remoteUsername      string
	remoteRestartWindow time.Time
	remoteRestarts      int
	pendingICE          []webrtc.ICECandidateInit
	initialOffer        bool
	needOffer           bool
	serverOfferID       string
	offerAt             time.Time
	offerNumber         uint64
	restartWindow       time.Time
	restarts            int
	wake                chan struct{}
	subMu               sync.Mutex
	subscriptions       map[string]*subscription
	hints               map[string]tileHint
	selected            map[string]bool
	subscriptionCount   int
	controlMu           sync.Mutex
	closed              atomic.Bool
	connected           atomic.Bool
	everConnected       atomic.Bool
	ready               atomic.Bool
	finalLeave          atomic.Bool
	overLimit           atomic.Bool
	authorizedUntil     atomic.Int64
	maxBitrate          atomic.Int64
	targetBitrate       atomic.Int64
	byteMu              sync.Mutex
	byteWindow          time.Time
	inboundBytes        int
	inboundPackets      int
}

func newMediaPeer(ctx context.Context, e *SFU, r *room, g Grant, policy AdmissionPolicy, generation int64, send func(Signal) error) *mediaPeer {
	ctx, cancel := context.WithCancel(ctx)
	p := &mediaPeer{engine: e, room: r, grant: g, generation: generation, ctx: ctx, cancel: cancel, send: send, publications: map[string]string{}, knownTracks: map[string]string{}, subscriptions: map[string]*subscription{}, hints: map[string]tileHint{}, wake: make(chan struct{}, 1)}
	p.maxBitrate.Store(int64(policy.MaxBitrate))
	p.targetBitrate.Store(int64(min(800000, policy.MaxBitrate)))
	p.authorizedUntil.Store(time.Now().Add(5 * time.Second).UnixNano())
	return p
}
func (p *mediaPeer) initialize() error {
	engine, registry, err := mediaEngine(int(p.maxBitrate.Load()), func(rate int) { p.targetBitrate.Store(int64(max(rate, 64000))) })
	if err != nil {
		return err
	}
	api := webrtc.NewAPI(webrtc.WithMediaEngine(engine), webrtc.WithInterceptorRegistry(registry), webrtc.WithSettingEngine(p.engine.settings()))
	pc, err := api.NewPeerConnection(webrtc.Configuration{ICEServers: []webrtc.ICEServer{}, BundlePolicy: webrtc.BundlePolicyMaxBundle, RTCPMuxPolicy: webrtc.RTCPMuxPolicyRequire})
	if err != nil {
		return err
	}
	p.mu.Lock()
	p.pc = pc
	p.mu.Unlock()
	pc.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate != nil {
			if p.emit("ice", "", candidate.ToJSON()) != nil {
				go func() { _ = p.Close() }()
			}
		}
	})
	// No OnNegotiationNeeded: for the track-less transceivers a listen-only browser's
	// offer creates, Pion reports negotiation as needed after every exchange, and both
	// sides would offer each other forever. The SFU offers only when it adds or removes
	// a subscriber track (requestOffer) or restarts ICE.
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) { go p.connectionChanged(state) })
	pc.OnDataChannel(func(*webrtc.DataChannel) { go func() { _ = p.Close() }() })
	pc.OnTrack(p.onTrack)
	p.ready.Store(true)
	go p.offerLoop()
	go p.authorizeLoop()
	go func() {
		timer := time.NewTimer(10 * time.Second)
		defer timer.Stop()
		select {
		case <-p.ctx.Done():
		case <-timer.C:
			if !p.everConnected.Load() {
				_ = p.Close()
			}
		}
	}()
	return nil
}
func (p *mediaPeer) emit(kind, id string, data any) error {
	if p.closed.Load() {
		return errors.New("transport closed")
	}
	raw, err := json.Marshal(data)
	if err != nil {
		return errors.New("cannot encode signal")
	}
	return p.send(Signal{Version: 1, Type: kind, NegotiationID: id, Data: raw})
}

// requestOffer asks for a server offer once signalling is stable; mu must not be held.
func (p *mediaPeer) requestOffer() {
	p.mu.Lock()
	p.needOffer = true
	p.mu.Unlock()
	p.wakeOffer()
}
func (p *mediaPeer) wakeOffer() {
	select {
	case p.wake <- struct{}{}:
	default:
	}
}
func (p *mediaPeer) reply(kind, requestID string, data any) error {
	raw, err := json.Marshal(data)
	if err != nil {
		return errors.New("cannot encode signal")
	}
	return p.send(Signal{Version: 1, Type: kind, RequestID: requestID, Data: raw})
}
func (p *mediaPeer) offerLoop() {
	for {
		select {
		case <-p.ctx.Done():
			return
		case <-p.wake:
			p.mu.Lock()
			if !p.initialOffer || !p.needOffer || p.closed.Load() || p.pc.SignalingState() != webrtc.SignalingStateStable {
				p.mu.Unlock()
				continue
			}
			p.needOffer = false
			err := p.offerLocked(false)
			p.mu.Unlock()
			if err != nil {
				if labOfferFailed != nil {
					labOfferFailed(p, err)
				}
				_ = p.Close()
				return
			}
		}
	}
}
func (p *mediaPeer) offerLocked(restart bool) error {
	offer, err := p.pc.CreateOffer(&webrtc.OfferOptions{ICERestart: restart})
	if err != nil {
		return fmt.Errorf("cannot create media offer: %w", err)
	}
	p.offerNumber++
	p.serverOfferID = fmt.Sprintf("s-%d", p.offerNumber)
	p.offerAt = time.Now()
	if err = p.pc.SetLocalDescription(offer); err != nil {
		return fmt.Errorf("cannot set media offer: %w", err)
	}
	return p.emit("offer", p.serverOfferID, map[string]string{"sdp": offer.SDP})
}

func (p *mediaPeer) descriptionCandidatesLocked(username string, candidates []string) error {
	if p.candidateKeys == nil {
		p.candidateKeys = map[string]bool{}
	}
	if p.remoteUsername != "" && p.remoteUsername != username {
		if time.Since(p.remoteRestartWindow) > 30*time.Second {
			p.remoteRestartWindow = time.Now()
			p.remoteRestarts = 0
		}
		p.remoteRestarts++
		if p.remoteRestarts > 3 {
			return errors.New("remote ICE restart limit")
		}
		p.candidateKeys = map[string]bool{}
		p.pendingICE = nil
	}
	p.remoteUsername = username
	for _, candidate := range candidates {
		p.candidateKeys[candidate] = true
	}
	if len(p.candidateKeys) > 64 {
		return errors.New("ICE candidate limit")
	}
	return nil
}

func (p *mediaPeer) Handle(ctx context.Context, m Signal) error {
	if p.closed.Load() {
		return errors.New("transport closed")
	}
	switch m.Type {
	case "offer", "answer":
		var data struct {
			SDP string `json:"sdp"`
		}
		if decodeStrict(m.Data, &data) != nil || m.NegotiationID == "" {
			return errors.New("invalid media description")
		}
		username, candidates, descriptionErr := descriptionInfo(data.SDP, p.engine.cfg.AllowLoopback)
		if descriptionErr != nil {
			return errors.New("invalid media description")
		}
		p.mu.Lock()
		defer p.mu.Unlock()
		if m.Type == "offer" {
			if p.pc.SignalingState() != webrtc.SignalingStateStable {
				return p.emit("error", m.NegotiationID, map[string]string{"code": "negotiation_collision"})
			}
			if err := p.descriptionCandidatesLocked(username, candidates); err != nil {
				return err
			}
			if err := p.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: data.SDP}); err != nil {
				return errors.New("media offer rejected")
			}
			answer, err := p.pc.CreateAnswer(nil)
			if err != nil {
				return errors.New("cannot answer media offer")
			}
			if err = p.pc.SetLocalDescription(answer); err != nil {
				return errors.New("cannot set media answer")
			}
			p.initialOffer = true
			if err = p.emit("answer", m.NegotiationID, map[string]string{"sdp": answer.SDP}); err != nil {
				return err
			}
		} else {
			if m.NegotiationID != p.serverOfferID || p.pc.SignalingState() != webrtc.SignalingStateHaveLocalOffer {
				return nil
			}
			if err := p.descriptionCandidatesLocked(username, candidates); err != nil {
				return err
			}
			if err := p.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: data.SDP}); err != nil {
				return errors.New("media answer rejected")
			}
			p.serverOfferID = ""
			p.offerAt = time.Time{}
		}
		for _, candidate := range p.pendingICE {
			if err := p.pc.AddICECandidate(candidate); err != nil {
				return errors.New("ICE candidate rejected")
			}
		}
		p.pendingICE = nil
		if p.needOffer {
			p.wakeOffer()
		}
		return nil
	case "ice":
		var candidate webrtc.ICECandidateInit
		if decodeStrict(m.Data, &candidate) != nil || validateCandidate(candidate.Candidate, p.engine.cfg.AllowLoopback) != nil {
			return errors.New("invalid ICE candidate")
		}
		if candidate.Candidate == "" {
			return nil
		}
		p.mu.Lock()
		defer p.mu.Unlock()
		key := strings.TrimPrefix(candidate.Candidate, "candidate:")
		if p.candidateKeys == nil {
			p.candidateKeys = map[string]bool{}
		}
		if p.candidateKeys[key] {
			return nil
		}
		p.candidateKeys[key] = true
		if len(p.candidateKeys) > 64 {
			return errors.New("ICE candidate limit")
		}
		if p.pc.RemoteDescription() == nil {
			p.pendingICE = append(p.pendingICE, candidate)
			return nil
		}
		if err := p.pc.AddICECandidate(candidate); err != nil {
			return errors.New("ICE candidate rejected")
		}
		return nil
	case "ice_restart":
		var data struct{}
		if decodeStrict(m.Data, &data) != nil {
			return errors.New("invalid ICE restart")
		}
		p.mu.Lock()
		defer p.mu.Unlock()
		if time.Since(p.restartWindow) > 30*time.Second {
			p.restartWindow = time.Now()
			p.restarts = 0
		}
		p.restarts++
		if p.restarts > 3 {
			return errors.New("ICE restart limit")
		}
		if p.pc.SignalingState() != webrtc.SignalingStateStable {
			return p.emit("error", m.NegotiationID, map[string]string{"code": "negotiation_collision"})
		}
		p.iceCount = 0
		return p.offerLocked(true)
	case "publish":
		var data struct {
			Kind    string `json:"kind"`
			TrackID string `json:"track_id"`
		}
		if decodeStrict(m.Data, &data) != nil || len(data.TrackID) == 0 || len(data.TrackID) > 128 || strings.IndexFunc(data.TrackID, unicode.IsControl) >= 0 {
			return errors.New("invalid publication")
		}
		if data.Kind != "audio" && data.Kind != "camera" && data.Kind != "screen" {
			return errors.New("invalid publication kind")
		}
		p.mu.Lock()
		if current := p.publications[data.Kind]; current != "" && current != data.TrackID {
			p.mu.Unlock()
			return errors.New("publication already exists")
		}
		if previous := p.knownTracks[data.TrackID]; previous != "" && previous != data.Kind {
			p.mu.Unlock()
			return errors.New("track kind cannot change")
		}
		for kind, id := range p.publications {
			if kind != data.Kind && id == data.TrackID {
				p.mu.Unlock()
				return errors.New("track already published")
			}
		}
		if data.Kind == "screen" && !p.room.claimScreen(p) {
			p.mu.Unlock()
			return p.reply("error", m.RequestID, map[string]string{"code": "screen_busy"})
		}
		if _, known := p.knownTracks[data.TrackID]; !known && len(p.knownTracks) >= 16 {
			p.mu.Unlock()
			return errors.New("publication lifetime limit")
		}
		p.publications[data.Kind] = data.TrackID
		p.knownTracks[data.TrackID] = data.Kind
		p.mu.Unlock()
		p.room.restorePublication(p, data.Kind, data.TrackID)
		return p.reply("published", m.RequestID, map[string]any{"kind": data.Kind, "max_bitrate": p.maxBitrate.Load()})
	case "unpublish":
		var data struct {
			Kind string `json:"kind"`
		}
		if decodeStrict(m.Data, &data) != nil {
			return errors.New("invalid unpublish")
		}
		if data.Kind != "audio" && data.Kind != "camera" && data.Kind != "screen" {
			return errors.New("invalid publication kind")
		}
		p.mu.Lock()
		delete(p.publications, data.Kind)
		p.mu.Unlock()
		p.room.removePublication(p, data.Kind)
		return nil
	case "tile":
		var data struct {
			TrackID string `json:"track_id"`
			tileHint
		}
		if decodeStrict(m.Data, &data) != nil || data.Width < 0 || data.Width > 4096 || data.Height < 0 || data.Height > 4096 {
			return errors.New("invalid tile hint")
		}
		p.subMu.Lock()
		defer p.subMu.Unlock()
		if _, ok := p.subscriptions[data.TrackID]; !ok {
			return nil
		}
		p.hints[data.TrackID] = data.tileHint
		return nil
	case "subscribe":
		var data struct {
			Tracks []string `json:"tracks"`
		}
		if decodeStrict(m.Data, &data) != nil || len(data.Tracks) > 24 {
			return errors.New("subscription limit")
		}
		selected := map[string]bool{}
		for _, id := range data.Tracks {
			if len(id) > 160 {
				return errors.New("invalid subscription")
			}
			selected[id] = true
		}
		p.subMu.Lock()
		p.selected = selected
		p.subMu.Unlock()
		return nil
	case "leave":
		p.finalLeave.Store(true)
		return nil
	default:
		return errors.New("unsupported peer signal")
	}
}

func (p *mediaPeer) connectionChanged(state webrtc.PeerConnectionState) {
	p.controlMu.Lock()
	defer p.controlMu.Unlock()
	p.mu.Lock()
	pc := p.pc
	p.mu.Unlock()
	if p.closed.Load() || pc == nil || pc.ConnectionState() != state {
		return
	}
	action := ""
	switch state {
	case webrtc.PeerConnectionStateConnected:
		action = "joined"
	case webrtc.PeerConnectionStateDisconnected:
		action = "disconnected"
	case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed:
		go func() { _ = p.Close() }()
		return
	default:
		return
	}
	if action == "disconnected" {
		p.connected.Store(false)
	}
	ctx, cancel := context.WithTimeout(p.ctx, 3*time.Second)
	defer cancel()
	policy, err := p.engine.cfg.Authority.Send(ctx, Control{Grant: p.grant, Action: action, TransportGeneration: p.generation})
	if err != nil {
		go func() { _ = p.Close() }()
		return
	}
	p.maxBitrate.Store(int64(policy.MaxBitrate))
	p.authorizedUntil.Store(time.Now().Add(5 * time.Second).UnixNano())
	if action == "joined" {
		p.everConnected.Store(true)
		p.connected.Store(true)
		if p.emit("policy", "", map[string]int{"max_bitrate": policy.MaxBitrate}) != nil {
			go func() { _ = p.Close() }()
		}
	}
}
func (p *mediaPeer) authorizeLoop() {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-p.ctx.Done():
			return
		case <-ticker.C:
			p.controlMu.Lock()
			ctx, cancel := context.WithTimeout(p.ctx, 3*time.Second)
			policy, err := p.engine.cfg.Authority.Send(ctx, Control{Grant: p.grant, Action: "authorize", TransportGeneration: p.generation})
			cancel()
			if err == nil {
				previous := p.maxBitrate.Swap(int64(policy.MaxBitrate))
				p.authorizedUntil.Store(time.Now().Add(5 * time.Second).UnixNano())
				if previous != int64(policy.MaxBitrate) {
					err = p.emit("policy", "", map[string]int{"max_bitrate": policy.MaxBitrate})
				}
			}
			p.controlMu.Unlock()
			p.mu.Lock()
			timedOut := !p.offerAt.IsZero() && time.Since(p.offerAt) > 10*time.Second
			p.mu.Unlock()
			// A refusal ends the transport at once. An unreachable chat server only
			// stops forwarding when the last authorization expires (permitted), and
			// ends the transport 10 seconds after that, so a lost request or a chat
			// restart does not drop the call.
			lapsed := time.Now().UnixNano() > p.authorizedUntil.Load()+int64(10*time.Second)
			if errors.Is(err, ErrAdmission) || (err != nil && lapsed) || timedOut {
				_ = p.Close()
				return
			}
		}
	}
}
func (p *mediaPeer) permitted() bool {
	return !p.closed.Load() && p.connected.Load() && time.Now().UnixNano() < p.authorizedUntil.Load()
}
func (p *mediaPeer) packetAllowed(size int) bool {
	if !p.permitted() || size > 1500 {
		return false
	}
	p.byteMu.Lock()
	defer p.byteMu.Unlock()
	if time.Since(p.byteWindow) >= time.Second {
		p.byteWindow = time.Now()
		p.inboundBytes = 0
		p.inboundPackets = 0
	}
	p.inboundBytes += size
	p.inboundPackets++
	limit := int(p.maxBitrate.Load())
	if p.inboundBytes*8 > limit*2 || p.inboundPackets > 3000 {
		if p.overLimit.CompareAndSwap(false, true) {
			go func() { _ = p.Close() }()
		}
		return false
	}
	return p.inboundBytes*8 <= limit && p.inboundPackets <= 2000
}
func (p *mediaPeer) Close() error {
	if !p.closed.CompareAndSwap(false, true) {
		return nil
	}
	if labClosed != nil {
		labClosed(p)
	}
	p.connected.Store(false)
	p.cancel()
	p.ready.Store(false)
	p.room.removePeer(p)
	p.engine.remove(p)
	if p.engine.turn != nil {
		p.engine.turn.drop(p.grant.ParticipantID, p.generation)
	}
	p.subMu.Lock()
	subscriptions := make([]*subscription, 0, len(p.subscriptions))
	for _, s := range p.subscriptions {
		subscriptions = append(subscriptions, s)
	}
	p.subscriptions = map[string]*subscription{}
	p.subMu.Unlock()
	for _, s := range subscriptions {
		s.close()
	}
	p.mu.Lock()
	pc := p.pc
	p.mu.Unlock()
	if pc != nil {
		_ = pc.Close()
	}
	p.engine.mu.Lock()
	shutdown := p.engine.closed
	p.engine.mu.Unlock()
	if !shutdown {
		p.controlMu.Lock()
		defer p.controlMu.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		action := "disconnected"
		if p.finalLeave.Load() {
			action = "left"
		}
		_, _ = p.engine.cfg.Authority.Send(ctx, Control{Grant: p.grant, Action: action, TransportGeneration: p.generation})
	}
	return nil
}

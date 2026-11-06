// SPDX-License-Identifier: AGPL-3.0-only
package media

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/pion/ice/v4"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// A browser that joins listen-only offers recvonly audio and video. Pion turns
// them into track-less transceivers and reports negotiation as needed after every
// exchange; the SFU must not answer that with offers of its own, or the two sides
// offer each other without end.
func TestSFUDoesNotOfferToAListenOnlyClient(t *testing.T) {
	call := uuid.NewString()
	engine, err := NewSFU(SFUConfig{PublicIP: "127.0.0.1", UDPAddr: "127.0.0.1:0", TCPAddr: "127.0.0.1:0", AllowLoopback: true, Authority: fixtureAuthority{call: call}})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = engine.Close() }()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pc := fixturePeer(t)
	defer func() { _ = pc.Close() }()
	for _, kind := range []webrtc.RTPCodecType{webrtc.RTPCodecTypeAudio, webrtc.RTPCodecTypeVideo} {
		if _, err = pc.AddTransceiverFromKind(kind, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}); err != nil {
			t.Fatal(err)
		}
	}
	var mu sync.Mutex
	var signals []Signal
	remote, err := engine.Open(ctx, fixtureGrant(call), func(m Signal) error {
		mu.Lock()
		signals = append(signals, m)
		mu.Unlock()
		return nil
	})
	if err != nil {
		t.Fatal("admission failed")
	}
	defer func() { _ = remote.Close() }()
	offer, err := pc.CreateOffer(nil)
	if err != nil || pc.SetLocalDescription(offer) != nil {
		t.Fatal("offer setup failed")
	}
	raw, _ := json.Marshal(map[string]string{"sdp": offer.SDP})
	if remote.Handle(ctx, Signal{Version: 1, Type: "offer", NegotiationID: "c-1", Data: raw}) != nil {
		t.Fatal("offer rejected")
	}
	answered := 0
	sequence := 1
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		pending := signals
		signals = nil
		mu.Unlock()
		for _, m := range pending {
			switch m.Type {
			case "answer":
				var description struct {
					SDP string `json:"sdp"`
				}
				if json.Unmarshal(m.Data, &description) != nil || pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: description.SDP}) != nil {
					t.Fatal("answer rejected")
				}
				answered++
				// Browsers offer again once the first answer is in (as Chrome does).
				if answered == 1 {
					sequence++
					again, err := pc.CreateOffer(nil)
					if err != nil || pc.SetLocalDescription(again) != nil {
						t.Fatal("second offer setup failed")
					}
					raw, _ := json.Marshal(map[string]string{"sdp": again.SDP})
					if remote.Handle(ctx, Signal{Version: 1, Type: "offer", NegotiationID: fmt.Sprintf("c-%d", sequence), Data: raw}) != nil {
						t.Fatal("second offer rejected")
					}
				}
			case "offer":
				t.Fatal("the SFU offered to a listen-only client without any track change")
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	if answered != 2 {
		t.Fatalf("%d of 2 client offers answered", answered)
	}
}

// Browsers probe bandwidth with padding-only packets on the video stream. They
// carry no VP8 payload; the SFU skips them and keeps the publisher connected.
func TestSFUSkipsPaddingOnlyVideoPackets(t *testing.T) {
	call := uuid.NewString()
	engine, err := NewSFU(SFUConfig{PublicIP: "127.0.0.1", UDPAddr: "127.0.0.1:0", TCPAddr: "127.0.0.1:0", AllowLoopback: true, Authority: fixtureAuthority{call: call}})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = engine.Close() }()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	received := make(chan []byte, 1)
	failures := make(chan error, 4)
	publisher, _ := newFixtureClient(t, ctx, engine, fixtureGrant(call), false, nil, failures)
	defer func() { _ = publisher.Close() }()
	receiver, _ := newFixtureClient(t, ctx, engine, fixtureGrant(call), false, received, failures)
	defer func() { _ = receiver.Close() }()
	// Publish a single-layer VP8 screen from the first client.
	engine.mu.Lock()
	var owner *mediaPeer
	for _, peer := range engine.peers {
		if owner == nil || peer.generation < owner.generation {
			owner = peer
		}
	}
	engine.mu.Unlock()
	if owner == nil {
		t.Fatal("publisher not admitted")
	}
	screen, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000}, "fixture-screen", "fixture-screen")
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(map[string]string{"kind": "screen", "track_id": "fixture-screen"})
	if owner.Handle(ctx, Signal{Version: 1, Type: "publish", Data: raw}) != nil {
		t.Fatal("screen publication refused")
	}
	if _, err = publisher.AddTrack(screen); err != nil {
		t.Fatal(err)
	}
	offer, err := publisher.CreateOffer(nil)
	if err != nil || publisher.SetLocalDescription(offer) != nil {
		t.Fatal("offer setup failed")
	}
	raw, _ = json.Marshal(map[string]string{"sdp": offer.SDP})
	if owner.Handle(ctx, Signal{Version: 1, Type: "offer", NegotiationID: "c-2", Data: raw}) != nil {
		t.Fatal("offer rejected")
	}
	// VP8 descriptor (S=1), then a key frame: frame tag (P=0, shown), start code, 640x360.
	frame := []byte{0x10, 0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0x68, 0x01}
	go func() {
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		sequence := uint16(0)
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				sequence++
				_ = screen.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2, Padding: true, PaddingSize: 200, SequenceNumber: sequence, Timestamp: 3000, PayloadType: 96}})
				sequence++
				_ = screen.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2, Marker: true, SequenceNumber: sequence, Timestamp: 3000, PayloadType: 96}, Payload: frame})
			}
		}
	}()
	select {
	case data := <-received:
		if len(data) == 0 {
			t.Fatal("an empty packet was forwarded")
		}
	case err := <-failures:
		t.Fatalf("fixture signaling failed: %v", err)
	case <-ctx.Done():
		t.Fatal("the screen frame was not forwarded")
	}
	if owner.closed.Load() {
		t.Fatal("padding closed the publisher")
	}
}

func fixturePeer(t *testing.T) *webrtc.PeerConnection {
	t.Helper()
	codecs, registry, err := mediaEngine(2500000, func(int) {})
	if err != nil {
		t.Fatal(err)
	}
	var settings webrtc.SettingEngine
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetIPFilter(func(ip net.IP) bool { return ip.IsLoopback() })
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	settings.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	settings.LoggerFactory = mediaLogger
	pc, err := webrtc.NewAPI(webrtc.WithMediaEngine(codecs), webrtc.WithInterceptorRegistry(registry), webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{BundlePolicy: webrtc.BundlePolicyMaxBundle})
	if err != nil {
		t.Fatal(err)
	}
	return pc
}

// A publisher that reconnects publishes anew under the same key. When the new
// publication reaches a receiver before the old one is removed, the receiver
// must switch to it: keeping the old subscription would lose the publisher for
// good once the old publication goes.
func TestSFUReplacesASubscriptionToAReplacedPublication(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	call := uuid.NewString()
	engine, err := NewSFU(SFUConfig{PublicIP: "127.0.0.1", UDPAddr: "127.0.0.1:0", TCPAddr: "127.0.0.1:0", AllowLoopback: true, Authority: fixtureAuthority{call: call}})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = engine.Close() }()
	failures := make(chan error, 4)
	received := make(chan []byte, 1)
	publisherGrant := fixtureGrant(call)
	publisher, track := newFixtureClient(t, ctx, engine, publisherGrant, true, nil, failures)
	defer func() { _ = publisher.Close() }()
	receiver, _ := newFixtureClient(t, ctx, engine, fixtureGrant(call), false, received, failures)
	defer func() { _ = receiver.Close() }()
	go func() {
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		for sequence := uint16(1); ; sequence++ {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				_ = track.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: sequence, Timestamp: uint32(sequence) * 960, PayloadType: 111}, Payload: []byte{0xf8, 0xff, 0xfe}})
			}
		}
	}()
	select {
	case <-received:
	case err := <-failures:
		t.Fatalf("fixture signaling failed: %v", err)
	case <-ctx.Done():
		t.Fatal("no forwarded audio")
	}
	engine.mu.Lock()
	var watcher *mediaPeer
	for id, peer := range engine.peers {
		if id != publisherGrant.ParticipantID {
			watcher = peer
		}
	}
	engine.mu.Unlock()
	key := publisherGrant.ParticipantID + ":audio"
	watcher.subMu.Lock()
	old := watcher.subscriptions[key]
	watcher.subMu.Unlock()
	if old == nil {
		t.Fatal("receiver has no subscription")
	}
	// The same key, a new publication, while the old one is still in place.
	replacement := &publication{room: old.source.room, owner: old.source.owner, key: key, kind: "audio", remoteID: "replacement", codec: old.source.codec, layers: map[string]*inboundLayer{}, subscribers: map[*subscription]bool{}}
	watcher.addSubscription(replacement)
	watcher.subMu.Lock()
	current := watcher.subscriptions[key]
	watcher.subMu.Unlock()
	if current == nil || current.source != replacement {
		t.Fatal("the receiver kept its subscription to the replaced publication")
	}
	if old.ctx.Err() == nil {
		t.Fatal("the stale subscription was not closed")
	}
}

type switchAuthority struct{ mode atomic.Value }

func (a *switchAuthority) Send(context.Context, Control) (AdmissionPolicy, error) {
	switch a.mode.Load() {
	case "unavailable":
		return AdmissionPolicy{}, errors.New("media authorization unavailable")
	case "deny":
		return AdmissionPolicy{}, ErrAdmission
	}
	return AdmissionPolicy{Allowed: true, MaxBitrate: 2500000, MaxParticipants: 8}, nil
}

// A chat server that cannot be reached for a moment does not end the call; one
// that refuses does, at once.
func TestSFUOutlastsAnUnreachableChatServerButNotARefusal(t *testing.T) {
	authority := &switchAuthority{}
	authority.mode.Store("allow")
	engine, err := NewSFU(SFUConfig{PublicIP: "127.0.0.1", UDPAddr: "127.0.0.1:0", TCPAddr: "127.0.0.1:0", AllowLoopback: true, Authority: authority})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = engine.Close() }()
	opened, err := engine.Open(context.Background(), fixtureGrant(uuid.NewString()), func(Signal) error { return nil })
	if err != nil {
		t.Fatal("admission failed")
	}
	peer := opened.(*mediaPeer)
	authority.mode.Store("unavailable")
	time.Sleep(2500 * time.Millisecond)
	if peer.closed.Load() {
		t.Fatal("one unanswered authorization ended the transport")
	}
	authority.mode.Store("deny")
	deadline := time.Now().Add(3 * time.Second)
	for !peer.closed.Load() && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if !peer.closed.Load() {
		t.Fatal("a refused authorization did not end the transport")
	}
}

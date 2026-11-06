// SPDX-License-Identifier: AGPL-3.0-only
package media

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/pion/ice/v4"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

type fixtureAuthority struct{ call string }

func (a fixtureAuthority) Send(_ context.Context, c Control) (AdmissionPolicy, error) {
	if c.CallID != a.call {
		return AdmissionPolicy{}, ErrAdmission
	}
	return AdmissionPolicy{Allowed: true, MaxBitrate: 2500000, MaxParticipants: 8}, nil
}
func fixtureGrant(call string) Grant {
	return Grant{UserID: uuid.NewString(), CallID: call, ParticipantID: uuid.NewString(), SessionID: uuid.NewString(), NodeGeneration: uuid.NewString()}
}

// Real local ICE, DTLS and SRTP between two Pion peers through the SFU.
func TestSFURealAudioForwarding(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	call := uuid.NewString()
	engine, err := NewSFU(SFUConfig{PublicIP: "127.0.0.1", UDPAddr: "127.0.0.1:0", TCPAddr: "127.0.0.1:0", AllowLoopback: true, Authority: fixtureAuthority{call: call}})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = engine.Close() }()
	received := make(chan []byte, 1)
	failures := make(chan error, 4)
	publisher, track := newFixtureClient(t, ctx, engine, fixtureGrant(call), true, nil, failures)
	defer func() { _ = publisher.Close() }()
	receiver, _ := newFixtureClient(t, ctx, engine, fixtureGrant(call), false, received, failures)
	defer func() { _ = receiver.Close() }()
	payload := []byte{0xf8, 0xff, 0xfe}
	go func() {
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		sequence := uint16(0)
		timestamp := uint32(0)
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				sequence++
				timestamp += 960
				_ = track.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: sequence, Timestamp: timestamp, PayloadType: 111}, Payload: payload})
			}
		}
	}()
	select {
	case data := <-received:
		if !bytes.Equal(data, payload) {
			t.Fatal("forwarded Opus payload changed")
		}
	case err := <-failures:
		t.Fatalf("fixture signaling failed: %v", err)
	case <-ctx.Done():
		t.Fatal("receiver did not receive RTP")
	}
}

func newFixtureClient(t *testing.T, ctx context.Context, engine *SFU, grant Grant, publish bool, received chan<- []byte, failures chan<- error) (*webrtc.PeerConnection, *webrtc.TrackLocalStaticRTP) {
	return newFixtureClientObserved(t, ctx, engine, grant, publish, received, failures, nil)
}
func newFixtureClientObserved(t *testing.T, ctx context.Context, engine *SFU, grant Grant, publish bool, received chan<- []byte, failures chan<- error, observer func(*webrtc.TrackRemote)) (*webrtc.PeerConnection, *webrtc.TrackLocalStaticRTP) {
	t.Helper()
	report := func() {
		select {
		case failures <- errors.New("fixture signaling failed"):
		default:
		}
	}
	codecs, registry, err := mediaEngine(2500000, func(int) {})
	if err != nil {
		t.Fatal("fixture codec setup failed")
	}
	var settings webrtc.SettingEngine
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetIPFilter(func(ip net.IP) bool { return ip.IsLoopback() })
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	settings.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	settings.LoggerFactory = mediaLogger
	pc, err := webrtc.NewAPI(webrtc.WithMediaEngine(codecs), webrtc.WithInterceptorRegistry(registry), webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{ICEServers: []webrtc.ICEServer{}, BundlePolicy: webrtc.BundlePolicyMaxBundle})
	if err != nil {
		t.Fatal("fixture peer setup failed")
	}
	outgoing := make(chan Signal, 128)
	remote, err := engine.Open(ctx, grant, func(m Signal) error {
		select {
		case outgoing <- m:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})
	if err != nil {
		_ = pc.Close()
		t.Fatal("fixture admission failed")
	}
	t.Cleanup(func() { _ = remote.Close() })
	pc.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate != nil {
			raw, _ := json.Marshal(candidate.ToJSON())
			if remote.Handle(ctx, Signal{Version: 1, Type: "ice", Data: raw}) != nil {
				report()
			}
		}
	})
	if received != nil || observer != nil {
		pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
			if observer != nil {
				observer(track)
				return
			}
			packet, _, err := track.ReadRTP()
			if err != nil {
				report()
				return
			}
			select {
			case received <- append([]byte(nil), packet.Payload...):
			case <-ctx.Done():
			}
		})
	}
	go func() {
		var pending []webrtc.ICECandidateInit
		for {
			select {
			case <-ctx.Done():
				return
			case m := <-outgoing:
				switch m.Type {
				case "offer", "answer":
					var description struct {
						SDP string `json:"sdp"`
					}
					if json.Unmarshal(m.Data, &description) != nil {
						report()
						return
					}
					kind := webrtc.SDPTypeAnswer
					if m.Type == "offer" {
						kind = webrtc.SDPTypeOffer
					}
					if pc.SetRemoteDescription(webrtc.SessionDescription{Type: kind, SDP: description.SDP}) != nil {
						report()
						return
					}
					for _, candidate := range pending {
						if pc.AddICECandidate(candidate) != nil {
							report()
							return
						}
					}
					pending = nil
					if m.Type == "offer" {
						answer, err := pc.CreateAnswer(nil)
						if err != nil || pc.SetLocalDescription(answer) != nil {
							report()
							return
						}
						raw, _ := json.Marshal(map[string]string{"sdp": answer.SDP})
						if remote.Handle(ctx, Signal{Version: 1, Type: "answer", NegotiationID: m.NegotiationID, Data: raw}) != nil {
							report()
							return
						}
					}
				case "ice":
					var candidate webrtc.ICECandidateInit
					if json.Unmarshal(m.Data, &candidate) != nil {
						report()
						return
					}
					if pc.RemoteDescription() == nil {
						pending = append(pending, candidate)
					} else if pc.AddICECandidate(candidate) != nil {
						report()
						return
					}
				}
			}
		}
	}()
	var track *webrtc.TrackLocalStaticRTP
	if publish {
		track, err = webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "fixture-audio", "fixture-stream")
		if err != nil {
			t.Fatal("fixture audio setup failed")
		}
		if _, err = pc.AddTrack(track); err != nil {
			t.Fatal("fixture sender setup failed")
		}
		raw, _ := json.Marshal(map[string]string{"kind": "audio", "track_id": "fixture-audio"})
		if remote.Handle(ctx, Signal{Version: 1, Type: "publish", Data: raw}) != nil {
			t.Fatal("fixture publication failed")
		}
	} else {
		if _, err = pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}); err != nil {
			t.Fatal("fixture receiver setup failed")
		}
	}
	offer, err := pc.CreateOffer(nil)
	if err != nil || pc.SetLocalDescription(offer) != nil {
		t.Fatal("fixture offer setup failed")
	}
	raw, _ := json.Marshal(map[string]string{"sdp": offer.SDP})
	if remote.Handle(ctx, Signal{Version: 1, Type: "offer", NegotiationID: "c-1", Data: raw}) != nil {
		t.Fatal("fixture offer rejected")
	}
	return pc, track
}

func TestSFUReplacesTransportWithoutDuplicatingParticipant(t *testing.T) {
	call := uuid.NewString()
	engine, err := NewSFU(SFUConfig{PublicIP: "127.0.0.1", UDPAddr: "127.0.0.1:0", TCPAddr: "127.0.0.1:0", AllowLoopback: true, Authority: fixtureAuthority{call: call}})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = engine.Close() }()
	grant := fixtureGrant(call)
	send := func(Signal) error { return nil }
	first, err := engine.Open(context.Background(), grant, send)
	if err != nil {
		t.Fatal("first admission failed")
	}
	second, err := engine.Open(context.Background(), grant, send)
	if err != nil {
		t.Fatal("replacement admission failed")
	}
	a := first.(*mediaPeer)
	b := second.(*mediaPeer)
	if !a.closed.Load() || a.generation >= b.generation {
		t.Fatal("obsolete transport was not fenced")
	}
	engine.mu.Lock()
	count := len(engine.peers)
	current := engine.peers[grant.ParticipantID]
	engine.mu.Unlock()
	if count != 1 || current != b {
		t.Fatal("duplicate participant survived replacement")
	}
}

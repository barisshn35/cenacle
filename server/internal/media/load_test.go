// SPDX-License-Identifier: AGPL-3.0-only
package media

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

type loadAuthority struct {
	rooms map[string]bool
	limit int
}

func (a loadAuthority) Send(_ context.Context, c Control) (AdmissionPolicy, error) {
	if !a.rooms[c.CallID] {
		return AdmissionPolicy{}, ErrAdmission
	}
	return AdmissionPolicy{Allowed: true, MaxBitrate: 2500000, MaxParticipants: a.limit}, nil
}

// Explicit lab authority bypasses the production chat admission cap only inside
// this test process. Synthetic audio transport smoke, NOT a camera/capacity pass.
func TestSFUAudioLoad(t *testing.T) {
	if os.Getenv("CALLS_LOAD") != "1" {
		t.Skip("opt-in load fixture (CALLS_LOAD=1)")
	}
	people, _ := strconv.Atoi(os.Getenv("CALLS_LOAD_PARTICIPANTS"))
	if people == 0 {
		people = 8
	}
	rooms, _ := strconv.Atoi(os.Getenv("CALLS_LOAD_ROOMS"))
	if rooms == 0 {
		rooms = 2
	}
	seconds, _ := strconv.Atoi(os.Getenv("CALLS_LOAD_SECONDS"))
	if seconds == 0 {
		seconds = 60
	}
	loss, _ := strconv.Atoi(os.Getenv("CALLS_LOAD_DROP_PERCENT"))
	if (people != 8 && people != 16 && people != 25) || rooms < 1 || rooms > 4 || people*rooms > 100 || seconds < 10 || seconds > 3600 || loss < 0 || loss > 30 {
		t.Fatal("invalid bounded load profile")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(seconds+60)*time.Second)
	defer cancel()
	ids := map[string]bool{}
	for range rooms {
		ids[uuid.NewString()] = true
	}
	engine, err := NewSFU(SFUConfig{PublicIP: "127.0.0.1", UDPAddr: "127.0.0.1:0", TCPAddr: "127.0.0.1:0", AllowLoopback: true, Authority: loadAuthority{ids, people}})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = engine.Close() }()
	failures := make(chan error, 128)
	start := time.Now()
	var received atomic.Int64
	var octets atomic.Int64
	var latencyMu sync.Mutex
	var latency []int64
	observe := func(track *webrtc.TrackRemote) {
		for {
			packet, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			received.Add(1)
			octets.Add(int64(packet.MarshalSize()))
			delay := time.Since(start).Milliseconds() - int64(packet.Timestamp/48)
			if delay >= 0 && delay < 60000 {
				latencyMu.Lock()
				if len(latency) < 100000 {
					latency = append(latency, delay)
				}
				latencyMu.Unlock()
			}
		}
	}
	var tracks []*webrtc.TrackLocalStaticRTP
	var peers []*webrtc.PeerConnection
	for call := range ids {
		for range people {
			pc, track := newFixtureClientObserved(t, ctx, engine, fixtureGrant(call), true, nil, failures, observe)
			peers = append(peers, pc)
			tracks = append(tracks, track)
		}
	}
	defer func() {
		for _, pc := range peers {
			_ = pc.Close()
		}
	}()
	sent := int64(0)
	deadline := time.Now().Add(time.Duration(seconds) * time.Second)
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	sequence := uint16(0)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			t.Fatal("load deadline exceeded")
		case err := <-failures:
			t.Fatalf("fixture signaling failed: %v", err)
		case <-ticker.C:
			sequence++
			for _, track := range tracks {
				sent++
				if int(sequence)%100 < loss {
					continue
				}
				if err := track.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: sequence, Timestamp: uint32(time.Since(start).Milliseconds() * 48), PayloadType: 111}, Payload: []byte{0xf8, 0xff, 0xfe}}); err != nil {
					t.Fatal("fixture RTP write failed")
				}
			}
		}
	}
	if received.Load() == 0 {
		t.Fatal("no real forwarded RTP")
	}
	latencyMu.Lock()
	samples := append([]int64(nil), latency...)
	latencyMu.Unlock()
	sort.Slice(samples, func(i, j int) bool { return samples[i] < samples[j] })
	percentile := func(p int) int64 {
		if len(samples) == 0 {
			return -1
		}
		return samples[(len(samples)-1)*p/100]
	}
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	report := map[string]any{"profile": "loopback Opus silence, SFU AND clients in one process; not capacity qualification", "participants_per_room": people, "rooms": rooms, "duration_seconds": seconds, "intentional_drop_percent": loss, "sent_packets": sent, "received_packets": received.Load(), "expected_fanout_packets": sent * int64(people-1), "receive_bits_per_second": octets.Load() * 8 / int64(seconds), "forward_latency_p50_ms": percentile(50), "forward_latency_p95_ms": percentile(95), "process_heap_bytes": memory.HeapAlloc, "process_goroutines": runtime.NumGoroutine(), "cpu": "measure isolated media process externally", "rejoin": "separate transport replacement fixture required"}
	encoded, _ := json.MarshalIndent(report, "", "  ")
	t.Log(string(encoded))
	if path := os.Getenv("CALLS_LOAD_REPORT"); path != "" {
		if err := os.WriteFile(path, append(encoded, '\n'), 0600); err != nil {
			t.Fatal(fmt.Errorf("write load report: %w", err))
		}
	}
}

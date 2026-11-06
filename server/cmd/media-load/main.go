// SPDX-License-Identifier: AGPL-3.0-only

// Command media-load measures a running cenacle-media process. It stands in for
// the chat server (it answers the media server's signed control requests and
// issues admission tokens) and drives Pion clients that use the web app's
// signalling: Opus audio and three-layer VP8 simulcast cameras, tile hints,
// a reconnect half way through. It reports loss, delay, bandwidth, rejoin time
// and the media process's CPU and memory. A lab tool: it is in no image
// (docs/operations/performance.md).
package main

import (
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/binary"
	"encoding/json"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"

	"github.com/Cenacle-TR/cenacle/server/internal/cache"
	"github.com/Cenacle-TR/cenacle/server/internal/media"
)

type options struct {
	signal, origin, controlAddr, valkey, valkeyPassword, node, view, report string
	callsKey, controlKey                                                    string
	rooms, people, seconds, maxBitrate, cameras, rejoins                    int
	pid                                                                     int
	rejoin, verbose                                                         bool
	lab                                                                     string
}

func main() {
	var o options
	flag.StringVar(&o.signal, "signal", "ws://127.0.0.1:7880/media/ws", "the media server's signalling URL")
	flag.StringVar(&o.origin, "origin", "https://chat.load.test", "the Origin the media server expects (its CENACLE_PUBLIC_URL)")
	flag.StringVar(&o.controlAddr, "control", "127.0.0.1:7883", "where to answer the media server's control requests")
	flag.StringVar(&o.valkey, "valkey", "127.0.0.1:6379", "the media server's Valkey")
	flag.StringVar(&o.valkeyPassword, "valkey-password", "", "its password")
	flag.StringVar(&o.node, "node", "media-1", "the media node ID")
	flag.StringVar(&o.callsKey, "calls-key", "", "Ed25519 private key (PEM) that signs admission tokens")
	flag.StringVar(&o.controlKey, "control-key", "", "Ed25519 public key (PEM) of the media server's control requests")
	flag.IntVar(&o.rooms, "rooms", 1, "rooms")
	flag.IntVar(&o.people, "people", 8, "people per room")
	flag.IntVar(&o.cameras, "cameras", -1, "people per room with a camera on (-1: everyone)")
	flag.IntVar(&o.seconds, "seconds", 60, "how long media flows")
	flag.IntVar(&o.maxBitrate, "max-bitrate", 2500000, "the workspace's bitrate ceiling per person")
	flag.StringVar(&o.view, "view", "grid", "grid (every camera in a 400 px tile) or speaker (one 960 px tile, the rest 160 px)")
	flag.BoolVar(&o.rejoin, "rejoin", true, "each person reconnects, half way through")
	flag.IntVar(&o.rejoins, "rejoins", 1, "how many times everyone reconnects, evenly spaced (a soak)")
	flag.IntVar(&o.pid, "pid", 0, "the media process to sample CPU and memory of (from the host)")
	flag.StringVar(&o.report, "report", "", "write the JSON report here")
	flag.BoolVar(&o.verbose, "v", false, "log signalling and connection states")
	flag.StringVar(&o.lab, "lab", "", "a medialab build's state URL: explain streams that never arrived")
	flag.Parse()
	if err := run(o); err != nil {
		log.Fatal(err)
	}
}

func run(o options) error {
	if o.cameras < 0 || o.cameras > o.people {
		o.cameras = o.people
	}
	callsKey, err := readKey(o.callsKey, true)
	if err != nil {
		return err
	}
	controlKey, err := readKey(o.controlKey, false)
	if err != nil {
		return err
	}
	store := cache.New(o.valkey, o.valkeyPassword)
	defer store.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(o.seconds+120)*time.Second)
	defer cancel()

	// The chat server's side of admission: every signed request is allowed.
	limit := min(max(o.people, 2), media.MaxParticipantsCap)
	controlSrv := &http.Server{Addr: o.controlAddr, ReadHeaderTimeout: 5 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(io.LimitReader(r.Body, 8192))
		if _, err := media.VerifyControl(controlKey.(ed25519.PublicKey), string(raw), time.Now()); err != nil {
			http.Error(w, "denied", http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(media.AdmissionPolicy{Allowed: true, MaxBitrate: o.maxBitrate, MaxParticipants: limit})
	})}
	listener, err := (&net.ListenConfig{}).Listen(ctx, "tcp", o.controlAddr)
	if err != nil {
		return err
	}
	go func() { _ = controlSrv.Serve(listener) }()
	defer func() { _ = controlSrv.Close() }()

	valkey, err := store.Get()
	if err != nil {
		return err
	}
	generation, err := valkey.Do(ctx, valkey.B().Get().Key("cenacle:media:node:"+o.node).Build()).ToString()
	if err != nil {
		return fmt.Errorf("media node %s has no lease in Valkey: %w", o.node, err)
	}
	tokens := &media.Tokens{Private: callsKey.(ed25519.PrivateKey), KeyID: "calls-1", Issuer: strings.TrimSuffix(o.origin, "/"), Store: store}

	sampler := startSampler(ctx, o.pid)
	var clients []*client
	start := time.Now()
	for room := range o.rooms {
		call := uuid.NewString()
		for person := range o.people {
			c := &client{o: o, tokens: tokens, generation: generation, grant: media.Grant{UserID: uuid.NewString(), CallID: call, ParticipantID: uuid.NewString(), SessionID: uuid.NewString(), NodeGeneration: generation}, camera: person < o.cameras, room: room, stats: map[string]*stream{}}
			if err := c.join(ctx); err != nil {
				return fmt.Errorf("room %d person %d: %w", room, person, err)
			}
			clients = append(clients, c)
		}
	}
	joined := time.Since(start)
	log.Printf("%d people in %d rooms joined in %s", len(clients), o.rooms, joined.Round(time.Millisecond))
	// Media flows; half way through everyone reconnects once (the web app's path
	// after a lost connection) and the time until media flows again is measured.
	deadline := time.Now().Add(time.Duration(o.seconds) * time.Second)
	if o.rejoin {
		rounds := max(o.rejoins, 1)
		for round := range rounds {
			time.Sleep(time.Until(start.Add(joined + time.Duration(o.seconds)*time.Second*time.Duration(round+1)/time.Duration(rounds+1))))
			var wg sync.WaitGroup
			for _, c := range clients {
				wg.Add(1)
				go func() {
					defer wg.Done()
					c.reconnect(ctx)
				}()
				time.Sleep(50 * time.Millisecond)
			}
			wg.Wait()
		}
	}
	time.Sleep(time.Until(deadline))
	measured := time.Since(start) - joined
	if o.lab != "" {
		explainMissing(o.lab, clients)
	}
	if o.verbose {
		for _, c := range clients {
			c.mu.Lock()
			pc := c.pc
			c.mu.Unlock()
			for _, stat := range pc.GetStats() {
				switch v := stat.(type) {
				case webrtc.TransportStats:
					log.Printf("%s transport sent=%d received=%d", c.grant.ParticipantID[:8], v.BytesSent, v.BytesReceived)
				case webrtc.InboundRTPStreamStats:
					log.Printf("%s inbound %s packets=%d", c.grant.ParticipantID[:8], v.Kind, v.PacketsReceived)
				case webrtc.OutboundRTPStreamStats:
					log.Printf("%s outbound %s rid=%s packets=%d", c.grant.ParticipantID[:8], v.Kind, v.Rid, v.PacketsSent)
				}
			}
		}
	}
	for _, c := range clients {
		c.close()
	}
	return writeReport(o, clients, sampler.stop(), measured, joined)
}

type stream struct {
	kind           string
	packets, bytes atomic.Int64
	delays         delaySamples
	seqMu          sync.Mutex
	first, highest int64 // extended sequence numbers; first < 0 before any packet
	seen           bool
}

type delaySamples struct {
	mu      sync.Mutex
	samples []float64
}

func (d *delaySamples) add(ms float64) {
	d.mu.Lock()
	if len(d.samples) < 200000 {
		d.samples = append(d.samples, ms)
	}
	d.mu.Unlock()
}

type client struct {
	o          options
	tokens     *media.Tokens
	generation string
	grant      media.Grant
	camera     bool
	room       int

	mu        sync.Mutex
	pc        *webrtc.PeerConnection
	ws        *websocket.Conn
	writes    sync.Mutex
	stop      context.CancelFunc
	stats     map[string]*stream
	past      []*stream       // streams of the connection before the reconnect
	announced map[string]bool // tracks the SFU announced on the current connection
	audioID   string
	cameraID  string
	failMu    sync.Mutex
	failures  map[string]int
	rejoinAt  atomic.Int64
	rejoined  atomic.Int64 // nanoseconds from reconnect start to the first media packet
	sent      atomic.Int64
	request   atomic.Int64
	acks      sync.Map
}

func (c *client) join(ctx context.Context) error {
	connCtx, cancel := context.WithCancel(ctx)
	c.stop = cancel
	token, err := c.tokens.Issue(ctx, c.grant)
	if err != nil {
		return err
	}
	// As behind the proxy: the Host is the chat's, the Origin the web app's.
	ws, response, err := websocket.Dial(ctx, c.o.signal, &websocket.DialOptions{Host: strings.TrimPrefix(strings.TrimPrefix(c.o.origin, "https://"), "http://"), HTTPHeader: http.Header{"Origin": {c.o.origin}}})
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	if err != nil {
		return err
	}
	ws.SetReadLimit(media.MaxSignalBytes)
	c.mu.Lock()
	c.ws = ws
	c.mu.Unlock()
	pc, err := newPeer()
	if err != nil {
		return err
	}
	c.mu.Lock()
	c.pc = pc
	c.mu.Unlock()
	pc.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate != nil {
			_ = c.send("ice", "", "", candidate.ToJSON())
		}
	})
	pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) { c.receive(track) })
	if c.o.verbose {
		pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
			log.Printf("%s: connection %s", c.grant.ParticipantID[:8], state)
		})
	}
	// The SFU may announce publications before "authenticated", as the web app allows.
	admitted := make(chan struct{})
	go c.signals(connCtx, ws, pc, admitted)
	if err = c.send("authenticate", "", "", map[string]string{"token": token}); err != nil {
		return err
	}
	select {
	case <-admitted:
	case <-time.After(5 * time.Second):
		return errors.New("not admitted")
	}
	if c.audioID == "" {
		c.audioID, c.cameraID = "a-"+uuid.NewString(), "c-"+uuid.NewString()
	}
	// Publications are announced first, as the web app does.
	kinds := []string{"audio"}
	if c.camera {
		kinds = append(kinds, "camera")
	}
	for _, kind := range kinds {
		id := c.audioID
		if kind == "camera" {
			id = c.cameraID
		}
		if err = c.publish(ctx, kind, id); err != nil {
			return err
		}
	}
	audio, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, c.audioID, c.audioID)
	if err != nil {
		return err
	}
	if _, err = pc.AddTransceiverFromTrack(audio, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly}); err != nil {
		return err
	}
	var layers []*webrtc.TrackLocalStaticRTP
	if c.camera {
		var sender *webrtc.RTPSender
		var camera *webrtc.RTPTransceiver
		for i, rid := range []string{"q", "h", "f"} {
			track, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000}, c.cameraID, c.cameraID, webrtc.WithRTPStreamID(rid))
			if err != nil {
				return err
			}
			layers = append(layers, track)
			if i == 0 {
				transceiver, err := pc.AddTransceiverFromTrack(track, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
				if err != nil {
					return err
				}
				camera = transceiver
				sender = transceiver.Sender()
			} else if err = sender.AddEncoding(track); err != nil {
				return err
			}
		}
		keyframe := make(chan struct{}, 1)
		go readRTCP(connCtx, sender, keyframe)
		go c.sendVideo(connCtx, camera, layers, keyframe)
	}
	go c.sendAudio(connCtx, audio)
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return err
	}
	if err = pc.SetLocalDescription(offer); err != nil {
		return err
	}
	if c.o.verbose {
		log.Printf("%s offer:\n%s", c.grant.ParticipantID[:8], offer.SDP)
	}
	return c.send("offer", "", "c-1", map[string]string{"sdp": offer.SDP})
}

func (c *client) publish(ctx context.Context, kind, id string) error {
	request := "p-" + strconv.FormatInt(c.request.Add(1), 10)
	done := make(chan struct{})
	c.acks.Store(request, done)
	if err := c.send("publish", request, "", map[string]string{"kind": kind, "track_id": id}); err != nil {
		return err
	}
	select {
	case <-done:
		return nil
	case <-time.After(5 * time.Second):
		return errors.New("publication not confirmed")
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (c *client) send(kind, request, negotiation string, data any) error {
	raw, err := json.Marshal(data)
	if err != nil {
		return err
	}
	frame, err := json.Marshal(media.Signal{Version: 1, Type: kind, RequestID: request, NegotiationID: negotiation, Data: raw})
	if err != nil {
		return err
	}
	c.mu.Lock()
	ws := c.ws
	c.mu.Unlock()
	c.writes.Lock()
	defer c.writes.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return ws.Write(ctx, websocket.MessageText, frame)
}

func (c *client) signals(ctx context.Context, ws *websocket.Conn, pc *webrtc.PeerConnection, admitted chan<- struct{}) {
	for {
		_, raw, err := ws.Read(ctx)
		if err != nil {
			return
		}
		var m media.Signal
		if json.Unmarshal(raw, &m) != nil {
			continue
		}
		if c.o.verbose {
			log.Printf("%s < %s %s", c.grant.ParticipantID[:8], m.Type, string(m.Data)[:min(len(m.Data), 120)])
		}
		switch m.Type {
		case "authenticated":
			close(admitted)
		case "published":
			if done, ok := c.acks.LoadAndDelete(m.RequestID); ok {
				close(done.(chan struct{}))
			}
		case "offer", "answer":
			var d struct {
				SDP string `json:"sdp"`
			}
			if json.Unmarshal(m.Data, &d) != nil {
				continue
			}
			kind := webrtc.SDPTypeAnswer
			if m.Type == "offer" {
				kind = webrtc.SDPTypeOffer
			}
			if c.o.verbose {
				log.Printf("%s %s:\n%s", c.grant.ParticipantID[:8], m.Type, d.SDP)
			}
			if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: kind, SDP: d.SDP}); err != nil {
				c.failOpen(ctx, "remote "+m.Type+": "+err.Error())
				continue
			}
			if m.Type == "offer" {
				answer, err := pc.CreateAnswer(nil)
				if err != nil || pc.SetLocalDescription(answer) != nil {
					c.failOpen(ctx, "answer")
					continue
				}
				_ = c.send("answer", "", m.NegotiationID, map[string]string{"sdp": answer.SDP})
			}
		case "ice":
			var candidate webrtc.ICECandidateInit
			if json.Unmarshal(m.Data, &candidate) == nil {
				_ = pc.AddICECandidate(candidate)
			}
		case "track", "track_removed":
			var t struct {
				TrackID string `json:"track_id"`
				Kind    string `json:"kind"`
			}
			if json.Unmarshal(m.Data, &t) != nil {
				continue
			}
			c.mu.Lock()
			if c.announced == nil {
				c.announced = map[string]bool{}
			}
			c.announced[t.TrackID] = m.Type == "track"
			c.mu.Unlock()
			if m.Type == "track_removed" || t.Kind == "audio" {
				continue
			}
			c.mu.Lock()
			cameras := 0
			for _, s := range c.stats {
				if s.kind != "audio" {
					cameras++
				}
			}
			c.mu.Unlock()
			width, height := 400, 225
			if c.o.view == "speaker" {
				width, height = 160, 90
				if cameras == 0 {
					width, height = 960, 540
				}
			}
			_ = c.send("tile", "", "", map[string]any{"track_id": t.TrackID, "width": width, "height": height, "visible": true})
		case "error":
			c.failOpen(ctx, "server error "+string(m.Data))
		}
	}
}

// receive counts what the SFU forwards: loss from sequence gaps (the SFU
// rewrites sequence numbers per receiver), delay from the send time each
// packet carries in its last eight bytes.
func (c *client) receive(track *webrtc.TrackRemote) {
	key := track.StreamID()
	c.mu.Lock()
	s := c.stats[key]
	if s == nil {
		s = &stream{kind: track.Kind().String()}
		c.stats[key] = s
	}
	c.mu.Unlock()
	for {
		packet, _, err := track.ReadRTP()
		if err != nil {
			return
		}
		now := time.Now()
		if started := c.rejoinAt.Load(); started != 0 {
			if c.rejoined.Load() == 0 {
				c.rejoined.CompareAndSwap(0, now.UnixNano()-started)
			}
		}
		s.packets.Add(1)
		s.bytes.Add(int64(packet.MarshalSize()))
		s.track(packet.SequenceNumber)
		if n := len(packet.Payload); n >= 8 {
			sent := int64(binary.BigEndian.Uint64(packet.Payload[n-8:])) //nolint:gosec // a wall-clock stamp
			if delay := now.UnixNano() - sent; delay >= 0 && delay < int64(10*time.Second) {
				s.delays.add(float64(delay) / 1e6)
			}
		}
	}
}

func (c *client) fail(reason string) {
	c.failMu.Lock()
	if c.failures == nil {
		c.failures = map[string]int{}
	}
	c.failures[reason]++
	c.failMu.Unlock()
}

// failOpen counts a failure of a connection still in use; a closed one's last
// messages are not failures.
func (c *client) failOpen(ctx context.Context, reason string) {
	if ctx.Err() == nil {
		c.fail(reason)
	}
}

// track extends the 16-bit sequence number past wraps. Loss is what never came
// between the first and the highest number: a retransmission arriving late fills
// its gap instead of opening a new one.
func (s *stream) track(sequence uint16) {
	s.seqMu.Lock()
	defer s.seqMu.Unlock()
	if !s.seen {
		s.seen, s.first, s.highest = true, int64(sequence), int64(sequence)
		return
	}
	delta := int64(int16(sequence - uint16(s.highest))) //nolint:gosec // RTP serial-number arithmetic
	if delta > 0 {
		s.highest += delta
	}
}

func (s *stream) lost() int64 {
	s.seqMu.Lock()
	defer s.seqMu.Unlock()
	if !s.seen {
		return 0
	}
	return max(0, s.highest-s.first+1-s.packets.Load())
}

func (c *client) reconnect(ctx context.Context) {
	c.close()
	c.mu.Lock()
	for _, st := range c.stats {
		c.past = append(c.past, st)
	}
	c.stats = map[string]*stream{}
	c.announced = map[string]bool{}
	c.mu.Unlock()
	c.rejoined.Store(0)
	c.rejoinAt.Store(time.Now().UnixNano())
	if err := c.join(ctx); err != nil {
		c.fail("rejoin: " + err.Error())
	}
}

func (c *client) close() {
	if c.stop != nil {
		c.stop()
	}
	c.mu.Lock()
	pc, ws := c.pc, c.ws
	c.mu.Unlock()
	if ws != nil {
		_ = ws.Close(websocket.StatusNormalClosure, "")
	}
	if pc != nil {
		_ = pc.Close()
	}
}

func stamp(payload []byte) {
	binary.BigEndian.PutUint64(payload[len(payload)-8:], uint64(time.Now().UnixNano())) //nolint:gosec // a wall-clock stamp
}

func (c *client) sendAudio(ctx context.Context, track *webrtc.TrackLocalStaticRTP) {
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	payload := make([]byte, 80) // about 32 kbit/s, as the web app's Opus ceiling
	var sequence uint16
	var timestamp uint32
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			sequence++
			timestamp += 960
			stamp(payload)
			if track.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: sequence, Timestamp: timestamp, PayloadType: 111}, Payload: payload}) == nil {
				c.sent.Add(1)
			}
		}
	}
}

// Synthetic VP8 at the web app's camera layers: q 320x180 at 15 fps, h 640x360
// and f 1280x720 at 30 fps, within its sender budget (10/25/65 % of 75 % of the
// ceiling). Key frames every 2 s and on request (PLI/FIR).
func (c *client) sendVideo(ctx context.Context, camera *webrtc.RTPTransceiver, layers []*webrtc.TrackLocalStaticRTP, keyframe <-chan struct{}) {
	// Pion leaves the simulcast header extensions to the sender: each packet names
	// its m-line (mid) and layer (rid), as browsers do, once they are negotiated.
	var midID, ridID int
	extensions := func() bool {
		if midID != 0 && ridID != 0 {
			return true
		}
		for _, e := range camera.Sender().GetParameters().HeaderExtensions {
			switch e.URI {
			case "urn:ietf:params:rtp-hdrext:sdes:mid":
				midID = e.ID
			case "urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id":
				ridID = e.ID
			}
		}
		return midID != 0 && ridID != 0 && camera.Mid() != ""
	}
	budget := float64(c.o.maxBitrate) * 0.75
	type layer struct {
		track    *webrtc.TrackLocalStaticRTP
		fps      int
		bitrate  float64
		sequence uint16
		picture  uint16
		width    uint16
		height   uint16
	}
	all := []*layer{
		{track: layers[0], fps: 15, bitrate: budget * 0.10, width: 320, height: 180},
		{track: layers[1], fps: 30, bitrate: budget * 0.25, width: 640, height: 360},
		{track: layers[2], fps: 30, bitrate: budget * 0.65, width: 1280, height: 720},
	}
	ticker := time.NewTicker(time.Second / 30)
	defer ticker.Stop()
	frame := 0
	forceKey := true
	for {
		select {
		case <-ctx.Done():
			return
		case <-keyframe:
			forceKey = true
		case <-ticker.C:
			if !extensions() {
				continue
			}
			frame++
			key := forceKey || frame%60 == 0
			forceKey = false
			for _, l := range all {
				if l.fps == 15 && frame%2 == 1 && !key {
					continue
				}
				size := int(l.bitrate / float64(l.fps) / 8)
				if key {
					size *= 3
				}
				l.picture = (l.picture + 1) & 0x7fff
				timestamp := uint32(frame) * 3000 //nolint:gosec // RTP time wraps
				for offset := 0; offset < size; offset += 1100 {
					chunk := min(1100, size-offset)
					payload := make([]byte, 4, 4+chunk+18)
					first := offset == 0
					payload[0] = 0x80 // X: extended control bits follow
					if first {
						payload[0] |= 0x10 // S: start of the partition
					}
					payload[1] = 0x80 // I: picture ID
					binary.BigEndian.PutUint16(payload[2:], 0x8000|l.picture)
					if first {
						tag := byte(0x10) // shown frame
						if !key {
							tag |= 0x01 // inter frame
						}
						payload = append(payload, tag, 0x00, 0x00)
						if key {
							payload = append(payload, 0x9d, 0x01, 0x2a, byte(l.width), byte(l.width>>8), byte(l.height), byte(l.height>>8)) //nolint:gosec // 14-bit sizes, little endian
						}
					}
					payload = append(payload, make([]byte, max(chunk, 16))...)
					stamp(payload)
					l.sequence++
					packet := &rtp.Packet{Header: rtp.Header{Version: 2, Marker: offset+chunk >= size, SequenceNumber: l.sequence, Timestamp: timestamp, PayloadType: 96}, Payload: payload}
					_ = packet.SetExtension(uint8(midID), []byte(camera.Mid()))  //nolint:gosec // negotiated IDs are 1..14
					_ = packet.SetExtension(uint8(ridID), []byte(l.track.RID())) //nolint:gosec // negotiated IDs are 1..14
					if l.track.WriteRTP(packet) == nil {
						c.sent.Add(1)
					}
				}
			}
		}
	}
}

func readRTCP(ctx context.Context, sender *webrtc.RTPSender, keyframe chan<- struct{}) {
	for ctx.Err() == nil {
		packets, _, err := sender.ReadRTCP()
		if err != nil {
			return
		}
		for _, p := range packets {
			switch p.(type) {
			case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
				select {
				case keyframe <- struct{}{}:
				default:
				}
			}
		}
	}
}

func newPeer() (*webrtc.PeerConnection, error) {
	m := &webrtc.MediaEngine{}
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2, SDPFmtpLine: "minptime=10;useinbandfec=1;usedtx=1", RTCPFeedback: []webrtc.RTCPFeedback{{Type: "transport-cc"}, {Type: "nack"}}}, PayloadType: 111}, webrtc.RTPCodecTypeAudio); err != nil {
		return nil, err
	}
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000, RTCPFeedback: []webrtc.RTCPFeedback{{Type: "nack"}, {Type: "nack", Parameter: "pli"}, {Type: "ccm", Parameter: "fir"}, {Type: "transport-cc"}}}, PayloadType: 96}, webrtc.RTPCodecTypeVideo); err != nil {
		return nil, err
	}
	if err := webrtc.ConfigureSimulcastExtensionHeaders(m); err != nil {
		return nil, err
	}
	registry := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(m, registry); err != nil {
		return nil, err
	}
	var settings webrtc.SettingEngine
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	return webrtc.NewAPI(webrtc.WithMediaEngine(m), webrtc.WithInterceptorRegistry(registry), webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{BundlePolicy: webrtc.BundlePolicyMaxBundle})
}

func readKey(path string, private bool) (any, error) {
	raw, err := os.ReadFile(path) //nolint:gosec // an operator-given key file
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		return nil, fmt.Errorf("%s: no PEM block", path)
	}
	if private {
		key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
		if err != nil {
			return nil, err
		}
		if _, ok := key.(ed25519.PrivateKey); !ok {
			return nil, fmt.Errorf("%s: not an Ed25519 private key", path)
		}
		return key, nil
	}
	key, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	if _, ok := key.(ed25519.PublicKey); !ok {
		return nil, fmt.Errorf("%s: not an Ed25519 public key", path)
	}
	return key, nil
}

// The media process's CPU and memory, read from /proc every second.
type sampler struct {
	done    chan struct{}
	mu      sync.Mutex
	cpu     []float64
	rss     []int64
	txBytes int64
	stopped bool
}

func startSampler(ctx context.Context, pid int) *sampler {
	s := &sampler{done: make(chan struct{})}
	if pid <= 0 {
		close(s.done)
		return s
	}
	ticks := 100.0 // USER_HZ on Linux
	go func() {
		defer close(s.done)
		prevCPU, prevAt := procCPU(pid), time.Now()
		startTx := procTx(pid)
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.mu.Lock()
				if s.stopped {
					s.txBytes = procTx(pid) - startTx
					s.mu.Unlock()
					return
				}
				cpu, at := procCPU(pid), time.Now()
				s.cpu = append(s.cpu, (cpu-prevCPU)/ticks/at.Sub(prevAt).Seconds()*100)
				s.rss = append(s.rss, procRSS(pid))
				prevCPU, prevAt = cpu, at
				s.mu.Unlock()
			}
		}
	}()
	return s
}

func (s *sampler) stop() *sampler {
	s.mu.Lock()
	s.stopped = true
	s.mu.Unlock()
	<-s.done
	return s
}

func procCPU(pid int) float64 {
	raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(raw[strings.LastIndexByte(string(raw), ')')+2:]))
	if len(fields) < 13 {
		return 0
	}
	user, _ := strconv.ParseFloat(fields[11], 64)
	system, _ := strconv.ParseFloat(fields[12], 64)
	return user + system
}

func procRSS(pid int) int64 {
	raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		return 0
	}
	for line := range strings.SplitSeq(string(raw), "\n") {
		if value, ok := strings.CutPrefix(line, "VmRSS:"); ok {
			kb, _ := strconv.ParseInt(strings.Fields(value)[0], 10, 64)
			return kb * 1024
		}
	}
	return 0
}

// Bytes the process's network namespace sent on its interfaces (not loopback).
func procTx(pid int) int64 {
	raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/net/dev", pid))
	if err != nil {
		return 0
	}
	var total int64
	for line := range strings.SplitSeq(string(raw), "\n") {
		name, rest, ok := strings.Cut(line, ":")
		if !ok || strings.TrimSpace(name) == "lo" {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) >= 9 {
			n, _ := strconv.ParseInt(fields[8], 10, 64)
			total += n
		}
	}
	return total
}

func percentile(values []float64, p float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sorted := append([]float64(nil), values...)
	sort.Float64s(sorted)
	return sorted[int(float64(len(sorted)-1)*p)]
}

func writeReport(o options, clients []*client, s *sampler, measured, joined time.Duration) error {
	var audioDelays, videoDelays, rejoins []float64
	var packets, bytes, lost int64
	streams := map[string]int{}
	failures := map[string]int{}
	for _, c := range clients {
		c.failMu.Lock()
		for reason, n := range c.failures {
			failures[reason] += n
		}
		c.failMu.Unlock()
		if d := c.rejoined.Load(); d > 0 {
			rejoins = append(rejoins, float64(d)/1e6)
		} else if o.rejoin {
			failures["no media after the reconnect"]++
		}
		c.mu.Lock()
		for _, st := range c.stats {
			streams[st.kind]++
		}
		remote := ""
		signaling := ""
		if c.pc != nil {
			if d := c.pc.CurrentRemoteDescription(); d != nil {
				remote = d.SDP
			}
			signaling = c.pc.SignalingState().String()
		}
		for track, live := range c.announced {
			if live && c.stats[track] == nil {
				if strings.Contains(remote, track) {
					failures["announced, negotiated, no media"]++
				} else {
					failures["announced, not negotiated, signalling "+signaling]++
				}
			}
		}
		for _, st := range append(append([]*stream(nil), c.past...), mapValues(c.stats)...) {
			packets += st.packets.Load()
			bytes += st.bytes.Load()
			lost += st.lost()
			st.delays.mu.Lock()
			if st.kind == "audio" {
				audioDelays = append(audioDelays, st.delays.samples...)
			} else {
				videoDelays = append(videoDelays, st.delays.samples...)
			}
			st.delays.mu.Unlock()
		}
		c.mu.Unlock()
	}
	// Everyone receives every other person's audio and every other camera.
	expectedVideo := o.rooms * (o.cameras*o.people - o.cameras)
	report := map[string]any{
		"rooms": o.rooms, "people_per_room": o.people, "cameras_per_room": o.cameras, "view": o.view,
		"seconds_measured": measured.Seconds(), "join_seconds": joined.Seconds(),
		"received_streams_after_rejoin": streams,
		"expected_streams":              map[string]int{"audio": o.rooms * o.people * (o.people - 1), "video": expectedVideo},
		"received_packets":              packets, "lost_packets": lost,
		"loss_percent":           100 * float64(lost) / float64(max(packets+lost, 1)),
		"egress_mbit_per_second": float64(bytes) * 8 / measured.Seconds() / 1e6,
		"audio_delay_ms":         map[string]float64{"p50": percentile(audioDelays, 0.5), "p95": percentile(audioDelays, 0.95), "p99": percentile(audioDelays, 0.99)},
		"video_delay_ms":         map[string]float64{"p50": percentile(videoDelays, 0.5), "p95": percentile(videoDelays, 0.95), "p99": percentile(videoDelays, 0.99)},
		"rejoin_ms":              map[string]float64{"p50": percentile(rejoins, 0.5), "p95": percentile(rejoins, 0.95), "max": percentile(rejoins, 1)},
		"failures":               failures,
	}
	if len(s.cpu) > 0 {
		var rss []float64
		for _, v := range s.rss {
			rss = append(rss, float64(v)/(1<<20))
		}
		report["media_cpu_percent_of_one_core"] = map[string]float64{"p50": percentile(s.cpu, 0.5), "p95": percentile(s.cpu, 0.95), "max": percentile(s.cpu, 1)}
		report["media_rss_mib"] = map[string]float64{"p50": percentile(rss, 0.5), "max": percentile(rss, 1), "first_minute": mean(rss[:min(60, len(rss))]), "last_minute": mean(rss[max(0, len(rss)-60):])}
		report["media_tx_mbit_per_second"] = float64(s.txBytes) * 8 / measured.Seconds() / 1e6
	}
	encoded, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return err
	}
	fmt.Println(string(encoded))
	if o.report != "" {
		return os.WriteFile(o.report, append(encoded, '\n'), 0o600)
	}
	return nil
}

func mapValues(m map[string]*stream) []*stream {
	out := make([]*stream, 0, len(m))
	for _, v := range m {
		out = append(out, v)
	}
	return out
}

// explainMissing prints, for each announced stream that never arrived, what
// the SFU says about that subscription.
func explainMissing(url string, clients []*client) {
	response, err := http.Get(url) //nolint:gosec,noctx // a lab URL the operator gives
	if err != nil {
		log.Printf("lab state: %v", err)
		return
	}
	defer func() { _ = response.Body.Close() }()
	var peers []struct {
		Participant string           `json:"participant"`
		Closed      bool             `json:"closed"`
		Connected   bool             `json:"connected"`
		Permitted   bool             `json:"permitted"`
		Signaling   string           `json:"signaling"`
		NeedOffer   bool             `json:"need_offer"`
		Subs        []map[string]any `json:"subscriptions"`
	}
	if json.NewDecoder(response.Body).Decode(&peers) != nil {
		return
	}
	for _, c := range clients {
		c.mu.Lock()
		var missing []string
		for track, live := range c.announced {
			if live && c.stats[track] == nil {
				missing = append(missing, track)
			}
		}
		c.mu.Unlock()
		if len(missing) == 0 {
			continue
		}
		for _, p := range peers {
			if p.Participant != c.grant.ParticipantID {
				continue
			}
			log.Printf("receiver %s closed=%v connected=%v permitted=%v signaling=%s need_offer=%v", p.Participant[:8], p.Closed, p.Connected, p.Permitted, p.Signaling, p.NeedOffer)
			for _, track := range missing {
				found := false
				for _, sub := range p.Subs {
					if sub["key"] == track {
						log.Printf("  missing %s: %v", track[:8]+track[36:], sub)
						found = true
					}
				}
				if !found {
					log.Printf("  missing %s: no subscription on the SFU", track[:8]+track[36:])
				}
			}
		}
	}
}

func mean(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sum := 0.0
	for _, v := range values {
		sum += v
	}
	return sum / float64(len(values))
}

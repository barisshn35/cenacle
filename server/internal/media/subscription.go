// SPDX-License-Identifier: AGPL-3.0-only
package media

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
)

type subscription struct {
	peer       *mediaPeer
	source     *publication
	local      *webrtc.TrackLocalStaticRTP
	sender     *webrtc.RTPSender
	ctx        context.Context
	cancel     context.CancelFunc
	queue      chan *rtp.Packet
	mu         sync.Mutex
	layer      string
	translator rtpTranslator
	drops      int
	dropWindow time.Time
	once       sync.Once
	written    atomic.Int64 // packets handed to the transport, for capacity diagnostics
}

func (p *mediaPeer) addSubscription(pub *publication) {
	if !p.ready.Load() || p.closed.Load() || pub.removed.Load() {
		return
	}
	p.subMu.Lock()
	if old, exists := p.subscriptions[pub.key]; exists && old.source != pub {
		// The publisher reconnected and its new publication arrived before the old
		// one was removed: replace the stale subscription, or the key stays taken
		// by a publication that is about to go and this person never receives it.
		delete(p.subscriptions, pub.key)
		p.subMu.Unlock()
		old.close()
		p.subMu.Lock()
	}
	if _, exists := p.subscriptions[pub.key]; exists {
		p.subMu.Unlock()
		return
	}
	if len(p.subscriptions) >= maxSubscriptions || p.subscriptionCount >= 128 {
		p.subMu.Unlock()
		go func() { _ = p.Close() }()
		return
	}
	// One stream per publication: browsers keep the stream ID of a reused receiver,
	// but not its track ID, so the stream ID is what names a publication there.
	local, err := webrtc.NewTrackLocalStaticRTP(pub.codec, pub.key, pub.key)
	if err != nil {
		p.subMu.Unlock()
		go func() { _ = p.Close() }()
		return
	}
	p.mu.Lock()
	sender, err := p.pc.AddTrack(local)
	p.mu.Unlock()
	if err != nil {
		p.subMu.Unlock()
		go func() { _ = p.Close() }()
		return
	}
	ctx, cancel := context.WithCancel(p.ctx)
	s := &subscription{peer: p, source: pub, local: local, sender: sender, ctx: ctx, cancel: cancel, queue: make(chan *rtp.Packet, 64)}
	p.subscriptionCount++
	p.subscriptions[pub.key] = s
	p.subMu.Unlock()
	p.requestOffer()
	pub.mu.Lock()
	if pub.removed.Load() {
		pub.mu.Unlock()
		p.removeSubscription(pub)
		return
	}
	pub.subscribers[s] = true
	pub.mu.Unlock()
	if p.emit("track", "", map[string]any{"track_id": pub.key, "stream_id": pub.key, "participant_id": pub.owner.grant.ParticipantID, "user_id": pub.owner.grant.UserID, "kind": pub.kind}) != nil {
		go func() { _ = p.Close() }()
		return
	}
	go s.pump()
	go s.readRTCP()
}
func (p *mediaPeer) removeSubscription(pub *publication) {
	p.subMu.Lock()
	s := p.subscriptions[pub.key]
	if s == nil || s.source != pub {
		p.subMu.Unlock()
		return
	}
	delete(p.subscriptions, pub.key)
	delete(p.hints, pub.key)
	p.subMu.Unlock()
	s.close()
	if !p.closed.Load() {
		_ = p.emit("track_removed", "", map[string]string{"track_id": pub.key})
	}
}
func (s *subscription) close() {
	s.once.Do(func() {
		s.cancel()
		s.source.mu.Lock()
		delete(s.source.subscribers, s)
		s.source.mu.Unlock()
		s.peer.mu.Lock()
		pc := s.peer.pc
		removed := false
		if pc != nil && !s.peer.closed.Load() {
			removed = pc.RemoveTrack(s.sender) == nil
		}
		s.peer.mu.Unlock()
		if removed {
			s.peer.requestOffer()
		}
	})
}

func (s *subscription) desiredLayer() string {
	if s.source.kind == "audio" {
		return ""
	}
	p := s.peer
	p.subMu.Lock()
	hint, hasHint := p.hints[s.source.key]
	selected := p.selected == nil || p.selected[s.source.key]
	videoCount := 0
	for _, sub := range p.subscriptions {
		if sub.source.kind != "audio" {
			videoCount++
		}
	}
	p.subMu.Unlock()
	if !selected || (hasHint && !hint.Visible) {
		return "off"
	}
	s.source.mu.Lock()
	available := map[string]bool{}
	for layer, input := range s.source.layers {
		if time.Now().UnixNano()-input.lastPacket.Load() < int64(3*time.Second) {
			available[layer] = true
		}
	}
	s.source.mu.Unlock()
	if s.source.kind == "screen" {
		if available[""] {
			return ""
		}
		return "off"
	}
	budget := min(p.targetBitrate.Load(), p.maxBitrate.Load()) * 8 / 10 / int64(max(videoCount, 1))
	want := 0
	width := 320
	if hasHint {
		width = hint.Width
	}
	if width > 320 && budget >= 450000 {
		want = 1
	}
	if width > 640 && budget >= 1200000 {
		want = 2
	}
	layers := []string{"q", "h", "f"}
	for i := want; i >= 0; i-- {
		if available[layers[i]] {
			return layers[i]
		}
	}
	for _, layer := range layers {
		if available[layer] {
			return layer
		}
	}
	return "off"
}

func (s *subscription) forward(layer string, packet *rtp.Packet, descriptor *codecs.VP8Packet) {
	if s.source.removed.Load() || !s.peer.permitted() {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	video := s.source.kind != "audio"
	desired := ""
	keyframe := false
	if video {
		desired = s.desiredLayer()
		if desired == "off" {
			return
		}
		keyframe = descriptor.S == 1 && descriptor.PID == 0 && len(descriptor.Payload) > 0 && descriptor.Payload[0]&1 == 0
		if !s.translator.initialized || s.layer != desired {
			if layer == desired && keyframe {
				s.layer = desired
				s.translator.switchSource(packet.SequenceNumber, packet.Timestamp)
			} else {
				s.source.requestKeyframe(desired)
			}
		}
		if !s.translator.initialized || layer != s.layer {
			return
		}
	}
	header := packet.Header
	header.Extensions = nil
	header.Extension = false
	header.CSRC = nil
	header.Padding = false
	out := &rtp.Packet{Header: header}
	if video {
		sequence, timestamp, frame, ok := s.translator.translate(packet.SequenceNumber, packet.Timestamp, descriptor.TID, keyframe)
		if !ok {
			return
		}
		out.SequenceNumber = sequence
		out.Timestamp = timestamp
		out.Payload = rewriteVP8(descriptor, frame)
	} else {
		out.Payload = append([]byte(nil), packet.Payload...)
	}
	if out.MarshalSize() > 1500 {
		return
	}
	select {
	case <-s.ctx.Done():
		return
	case s.queue <- out:
	default:
		if time.Since(s.dropWindow) > time.Second {
			s.dropWindow = time.Now()
			s.drops = 0
		}
		s.drops++
		if s.drops > 64 {
			go func() { _ = s.peer.Close() }()
		}
	}
}
func (s *subscription) pump() {
	for {
		select {
		case <-s.ctx.Done():
			return
		case packet := <-s.queue:
			if s.peer.permitted() {
				if s.local.WriteRTP(packet) != nil {
					go func() { _ = s.peer.Close() }()
					return
				}
				s.written.Add(1)
			}
		}
	}
}
func (s *subscription) readRTCP() {
	buffer := make([]byte, MaxRTCPBytes)
	window := time.Now()
	count := 0
	for {
		n, _, err := s.sender.Read(buffer)
		if err != nil {
			return
		}
		if time.Since(window) >= time.Second {
			window = time.Now()
			count = 0
		}
		count++
		packets, err := ParseRTCP(buffer[:n])
		if err != nil || count > 100 {
			go func() { _ = s.peer.Close() }()
			return
		}
		for _, packet := range packets {
			switch packet.(type) {
			case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
				s.mu.Lock()
				layer := s.layer
				s.mu.Unlock()
				s.source.requestKeyframe(layer)
			}
		}
	}
}

type frameTranslation struct {
	valid         bool
	input, output uint32
	picture       uint16
	tl0, key      uint8
}
type rtpTranslator struct {
	initialized     bool
	sequenceOffset  uint16
	timestampOffset uint32
	lastSequence    uint16
	lastTimestamp   uint32
	lastInput       uint32
	step            uint32
	picture         uint16
	tl0, key        uint8
	frames          [64]frameTranslation
	nextFrame       int
}

func (t *rtpTranslator) switchSource(sequence uint16, timestamp uint32) {
	if t.initialized {
		t.sequenceOffset = t.lastSequence + 1 - sequence
		step := t.step
		if step == 0 {
			step = 3000
		}
		t.timestampOffset = t.lastTimestamp + step - timestamp
	}
	t.initialized = true
	t.frames = [64]frameTranslation{}
	t.nextFrame = 0
	t.lastInput = timestamp
}
func (t *rtpTranslator) translate(sequence uint16, timestamp uint32, tid uint8, keyframe bool) (uint16, uint32, frameTranslation, bool) {
	sequence += t.sequenceOffset
	for _, frame := range t.frames {
		if frame.valid && frame.input == timestamp {
			if int16(sequence-t.lastSequence) > 0 { //nolint:gosec // RTP serial-number arithmetic wraps on purpose
				t.lastSequence = sequence
			}
			return sequence, frame.output, frame, true
		}
	}
	if t.nextFrame > 0 && int32(timestamp-t.lastInput) < 0 { //nolint:gosec // RTP serial-number arithmetic wraps on purpose
		return 0, 0, frameTranslation{}, false
	}
	output := timestamp + t.timestampOffset
	if t.nextFrame > 0 {
		step := timestamp - t.lastInput
		if step > 0 && step < 90000 {
			t.step = step
		}
	}
	t.picture = (t.picture + 1) & 0x7fff
	if tid == 0 {
		t.tl0++
	}
	if keyframe {
		t.key = (t.key + 1) & 31
	}
	frame := frameTranslation{valid: true, input: timestamp, output: output, picture: t.picture, tl0: t.tl0, key: t.key}
	t.frames[t.nextFrame%len(t.frames)] = frame
	t.nextFrame++
	t.lastInput = timestamp
	if t.nextFrame == 1 || int16(sequence-t.lastSequence) > 0 { //nolint:gosec // RTP serial-number arithmetic wraps on purpose
		t.lastSequence = sequence
	}
	if t.nextFrame == 1 || int32(output-t.lastTimestamp) > 0 { //nolint:gosec // RTP serial-number arithmetic wraps on purpose
		t.lastTimestamp = output
	}
	return sequence, output, frame, true
}
func rewriteVP8(in *codecs.VP8Packet, frame frameTranslation) []byte {
	first := byte(0x80) | (in.N << 5) | (in.S << 4) | in.PID
	flags := byte(0x80) | (in.L << 6) | (in.T << 5) | (in.K << 4)
	out := make([]byte, 0, len(in.Payload)+7)
	out = append(out, first, flags, 0x80|byte(frame.picture>>8), byte(frame.picture)) //nolint:gosec // 15-bit picture ID split into two bytes
	if in.L != 0 {
		out = append(out, frame.tl0)
	}
	if in.T != 0 || in.K != 0 {
		key := byte(0)
		if in.K != 0 {
			key = frame.key
		}
		out = append(out, (in.TID<<6)|(in.Y<<5)|key)
	}
	return append(out, in.Payload...)
}

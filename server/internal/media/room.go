// SPDX-License-Identifier: AGPL-3.0-only
package media

import (
	"context"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
)

type room struct {
	engine       *SFU
	id           string
	mu           sync.Mutex
	peers        map[string]*mediaPeer
	publications map[string]*publication
	sources      map[string]*publication
	screen       *mediaPeer
	speakers     map[string]time.Time
	ctx          context.Context
	cancel       context.CancelFunc
}
type inboundLayer struct {
	track        *webrtc.TrackRemote
	audioLevelID uint8
	lastPacket   atomic.Int64
}
type publication struct {
	room        *room
	owner       *mediaPeer
	key, kind   string
	remoteID    string
	codec       webrtc.RTPCodecCapability
	mu          sync.Mutex
	layers      map[string]*inboundLayer
	subscribers map[*subscription]bool
	removed     atomic.Bool
	lastPLI     time.Time
	pliBusy     atomic.Bool
}

func newRoom(e *SFU, id string) *room {
	ctx, cancel := context.WithCancel(context.Background())
	r := &room{engine: e, id: id, peers: map[string]*mediaPeer{}, publications: map[string]*publication{}, sources: map[string]*publication{}, speakers: map[string]time.Time{}, ctx: ctx, cancel: cancel}
	go r.speakerLoop()
	return r
}
func (r *room) claimScreen(p *mediaPeer) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if p.closed.Load() || r.peers[p.grant.ParticipantID] != p || (r.screen != nil && r.screen != p) {
		return false
	}
	r.screen = p
	return true
}
func (r *room) restorePublication(p *mediaPeer, kind, trackID string) {
	p.mu.Lock()
	if p.closed.Load() || p.publications[kind] != trackID {
		p.mu.Unlock()
		return
	}
	r.mu.Lock()
	pub := r.sources[p.grant.ParticipantID+":"+kind]
	if pub == nil || pub.owner != p || pub.remoteID != trackID || r.peers[p.grant.ParticipantID] != p {
		r.mu.Unlock()
		p.mu.Unlock()
		return
	}
	pub.removed.Store(false)
	r.publications[pub.key] = pub
	recipients := []*mediaPeer{}
	for _, peer := range r.peers {
		if peer != p {
			recipients = append(recipients, peer)
		}
	}
	r.mu.Unlock()
	p.mu.Unlock()
	for _, peer := range recipients {
		peer.addSubscription(pub)
	}
}
func (r *room) attachExisting(p *mediaPeer) {
	r.mu.Lock()
	list := make([]*publication, 0, len(r.publications))
	for _, pub := range r.publications {
		if pub.owner != p {
			list = append(list, pub)
		}
	}
	r.mu.Unlock()
	for _, pub := range list {
		p.addSubscription(pub)
	}
}
func (r *room) removePublication(p *mediaPeer, kind string) {
	key := p.grant.ParticipantID + ":" + kind
	r.mu.Lock()
	pub := r.publications[key]
	if pub != nil && pub.owner == p {
		delete(r.publications, key)
		pub.removed.Store(true)
	} else {
		pub = nil
	}
	if kind == "screen" && r.screen == p {
		r.screen = nil
	}
	r.mu.Unlock()
	if pub == nil {
		return
	}
	pub.mu.Lock()
	subscribers := make([]*subscription, 0, len(pub.subscribers))
	for s := range pub.subscribers {
		subscribers = append(subscribers, s)
	}
	pub.mu.Unlock()
	for _, s := range subscribers {
		s.peer.removeSubscription(pub)
	}
}
func (r *room) removePeer(p *mediaPeer) {
	for _, kind := range []string{"audio", "camera", "screen"} {
		r.removePublication(p, kind)
	}
	r.mu.Lock()
	for key, pub := range r.sources {
		if pub.owner == p {
			pub.removed.Store(true)
			delete(r.sources, key)
		}
	}
	delete(r.speakers, p.grant.UserID)
	r.mu.Unlock()
}

func (p *mediaPeer) onTrack(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
	p.mu.Lock()
	kind := p.knownTracks[track.ID()]
	active := p.publications[kind] == track.ID()
	p.incomingTracks++
	tooMany := p.incomingTracks > 16
	mime := strings.ToLower(track.Codec().MimeType)
	layer := track.RID()
	if tooMany || kind == "" || (kind == "audio" && (mime != strings.ToLower(webrtc.MimeTypeOpus) || layer != "")) || (kind != "audio" && mime != strings.ToLower(webrtc.MimeTypeVP8)) || (kind == "screen" && layer != "") || (kind == "camera" && layer != "q" && layer != "h" && layer != "f") {
		p.mu.Unlock()
		go func() { _ = p.Close() }()
		return
	}
	incoming := &inboundLayer{track: track}
	incoming.lastPacket.Store(time.Now().UnixNano())
	for _, extension := range receiver.GetParameters().HeaderExtensions {
		if extension.URI == "urn:ietf:params:rtp-hdrext:ssrc-audio-level" && extension.ID > 0 && extension.ID < 256 {
			incoming.audioLevelID = uint8(extension.ID)
		}
	}
	r := p.room
	key := p.grant.ParticipantID + ":" + kind
	r.mu.Lock()
	if r.peers[p.grant.ParticipantID] != p || (active && kind == "screen" && r.screen != p) {
		r.mu.Unlock()
		p.mu.Unlock()
		go func() { _ = p.Close() }()
		return
	}
	pub := r.sources[key]
	if !active && pub != nil && pub.owner == p && pub.remoteID != track.ID() {
		r.mu.Unlock()
		p.mu.Unlock()
		for {
			packet, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			_ = p.packetAllowed(packet.MarshalSize())
		}
	}
	fresh := r.publications[key] == nil
	if pub == nil || pub.owner != p {
		pub = &publication{room: r, owner: p, key: key, kind: kind, remoteID: track.ID(), codec: track.Codec().RTPCodecCapability, layers: map[string]*inboundLayer{}, subscribers: map[*subscription]bool{}}
		r.sources[key] = pub
	}
	pub.mu.Lock()
	if pub.remoteID != track.ID() {
		pub.remoteID = track.ID()
		pub.layers = map[string]*inboundLayer{}
	}
	pub.layers[layer] = incoming
	pub.mu.Unlock()
	if active {
		pub.removed.Store(false)
		r.publications[key] = pub
	} else {
		pub.removed.Store(true)
	}
	recipients := make([]*mediaPeer, 0, len(r.peers))
	if fresh && active {
		for _, peer := range r.peers {
			if peer != p {
				recipients = append(recipients, peer)
			}
		}
	}
	r.mu.Unlock()
	p.mu.Unlock()
	for _, peer := range recipients {
		peer.addSubscription(pub)
	}
	for {
		packet, _, err := track.ReadRTP()
		if err != nil {
			return
		}
		if !p.packetAllowed(packet.MarshalSize()) || pub.removed.Load() {
			continue
		}
		pub.mu.Lock()
		current := pub.layers[layer] == incoming
		pub.mu.Unlock()
		if !current {
			continue
		}
		incoming.lastPacket.Store(time.Now().UnixNano())
		var descriptor codecs.VP8Packet
		if kind != "audio" {
			// Browsers send padding-only packets to probe bandwidth: no payload to
			// forward. A malformed descriptor is dropped too; it never reaches anyone.
			if len(packet.Payload) == 0 {
				continue
			}
			if _, err = descriptor.Unmarshal(packet.Payload); err != nil {
				continue
			}
		}
		if kind == "audio" && incoming.audioLevelID != 0 {
			value := packet.GetExtension(incoming.audioLevelID)
			if len(value) == 1 && value[0]&0x7f < 45 {
				r.mu.Lock()
				r.speakers[p.grant.UserID] = time.Now()
				r.mu.Unlock()
			}
		}
		pub.mu.Lock()
		subscribers := make([]*subscription, 0, len(pub.subscribers))
		for s := range pub.subscribers {
			subscribers = append(subscribers, s)
		}
		pub.mu.Unlock()
		for _, s := range subscribers {
			s.forward(layer, packet, &descriptor)
		}
	}
}

func (p *publication) requestKeyframe(layer string) {
	p.mu.Lock()
	if p.removed.Load() || time.Since(p.lastPLI) < 500*time.Millisecond {
		p.mu.Unlock()
		return
	}
	p.lastPLI = time.Now()
	incoming := p.layers[layer]
	p.mu.Unlock()
	if incoming == nil || !p.pliBusy.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer p.pliBusy.Store(false)
		p.owner.mu.Lock()
		pc := p.owner.pc
		p.owner.mu.Unlock()
		if pc != nil {
			_ = pc.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: uint32(incoming.track.SSRC())}})
		}
	}()
}
func (r *room) speakerLoop() {
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	// What each peer was last told, so a newcomer also learns who is speaking.
	told := map[*mediaPeer]string{}
	for {
		select {
		case <-r.ctx.Done():
			return
		case <-ticker.C:
			r.mu.Lock()
			speaking := []string{}
			for user, at := range r.speakers {
				if time.Since(at) < 400*time.Millisecond {
					speaking = append(speaking, user)
				} else {
					delete(r.speakers, user)
				}
			}
			peers := make([]*mediaPeer, 0, len(r.peers))
			for _, p := range r.peers {
				peers = append(peers, p)
			}
			r.mu.Unlock()
			sort.Strings(speaking)
			key := strings.Join(speaking, ",")
			present := make(map[*mediaPeer]bool, len(peers))
			for _, p := range peers {
				present[p] = true
				if last, ok := told[p]; (ok && last == key) || (!ok && key == "") {
					continue
				}
				told[p] = key
				if p.permitted() {
					if p.emit("speaker", "", map[string]any{"participants": speaking}) != nil {
						go func(p *mediaPeer) { _ = p.Close() }(p)
					}
				}
			}
			for p := range told {
				if !present[p] {
					delete(told, p)
				}
			}
		}
	}
}

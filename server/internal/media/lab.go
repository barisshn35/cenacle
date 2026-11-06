// SPDX-License-Identifier: AGPL-3.0-only

//go:build medialab

package media

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"runtime"
	"strings"
)

// LabHandler shows every transport and subscription, for capacity
// measurements only (go build -tags medialab). Release builds have none.
func LabHandler(e *SFU) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		type sub struct {
			Key       string `json:"key"`
			Publisher string `json:"publisher_generation"`
			Removed   bool   `json:"removed"`
			Layer     string `json:"layer"`
			Written   int64  `json:"written"`
			Queued    int    `json:"queued"`
		}
		type peer struct {
			Participant string `json:"participant"`
			Generation  int64  `json:"generation"`
			Closed      bool   `json:"closed"`
			Connected   bool   `json:"connected"`
			Permitted   bool   `json:"permitted"`
			Signaling   string `json:"signaling"`
			NeedOffer   bool   `json:"need_offer"`
			Subs        []sub  `json:"subscriptions"`
		}
		e.mu.Lock()
		peers := make([]*mediaPeer, 0, len(e.peers))
		for _, p := range e.peers {
			peers = append(peers, p)
		}
		e.mu.Unlock()
		out := []peer{}
		for _, p := range peers {
			p.mu.Lock()
			v := peer{Participant: p.grant.ParticipantID, Generation: p.generation, Closed: p.closed.Load(), Connected: p.connected.Load(), Permitted: p.permitted(), NeedOffer: p.needOffer}
			if p.pc != nil {
				v.Signaling = p.pc.SignalingState().String()
			}
			p.mu.Unlock()
			p.subMu.Lock()
			for key, s := range p.subscriptions {
				s.mu.Lock()
				v.Subs = append(v.Subs, sub{Key: key, Publisher: fmtGeneration(s.source.owner), Removed: s.source.removed.Load(), Layer: s.layer, Written: s.written.Load(), Queued: len(s.queue)})
				s.mu.Unlock()
			}
			p.subMu.Unlock()
			out = append(out, v)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(out)
	})
}

func fmtGeneration(p *mediaPeer) string {
	if p == nil {
		return ""
	}
	if p.closed.Load() {
		return "closed"
	}
	return "live"
}

// labClosed logs who closed a transport: the first frames of the caller.
var labClosed = func(p *mediaPeer) {
	pcs := make([]uintptr, 8)
	n := runtime.Callers(3, pcs)
	frames := runtime.CallersFrames(pcs[:n])
	var path []string
	for {
		f, more := frames.Next()
		name := f.Function[strings.LastIndex(f.Function, "/")+1:]
		path = append(path, fmt.Sprintf("%s:%d", name, f.Line))
		if !more || len(path) == 4 {
			break
		}
	}
	fmt.Fprintf(os.Stderr, "LAB close %s gen=%d connected=%v by %s\n", p.grant.ParticipantID[:8], p.generation, p.connected.Load(), strings.Join(path, " < "))
}

// labSignalEnded logs why a signalling connection ended.
var labSignalEnded = func(p SignalPeer, reason string) {
	id := ""
	if m, ok := p.(*mediaPeer); ok {
		id = m.grant.ParticipantID[:8]
	}
	fmt.Fprintf(os.Stderr, "LAB signal end %s %s\n", id, reason)
}

// labOfferFailed logs why the SFU could not make an offer.
var labOfferFailed = func(p *mediaPeer, err error) {
	fmt.Fprintf(os.Stderr, "LAB offer failed %s %v\n", p.grant.ParticipantID[:8], err)
}

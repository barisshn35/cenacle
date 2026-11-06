// SPDX-License-Identifier: AGPL-3.0-only

// Package realtime delivers events to clients over WebSocket.
package realtime

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/Cenacle-TR/cenacle/server/internal/events"
)

// Hub follows the event log and hands every event to the clients connected
// to this instance.
type Hub struct {
	Log *events.Log
	// Ephemeral carries short-lived events (typing, presence); optional.
	Ephemeral *events.Ephemeral
	Logger    *slog.Logger

	mu      sync.Mutex
	clients map[*client]struct{}
}

func (h *Hub) add(c *client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.clients == nil {
		h.clients = map[*client]struct{}{}
	}
	h.clients[c] = struct{}{}
}

func (h *Hub) remove(c *client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.clients, c)
}

// Clients returns the number of connected clients.
func (h *Hub) Clients() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.clients)
}

func (h *Hub) broadcast(ev events.Event) {
	p := prepare(ev) // once, for every connection
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.clients {
		c.deliver(p)
	}
}

func (h *Hub) resyncAll() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.clients {
		c.requestResync()
	}
}

// RunEphemeral hands short-lived events to the clients until ctx ends,
// subscribing again after failures.
func (h *Hub) RunEphemeral(ctx context.Context) {
	if h.Ephemeral == nil {
		return
	}
	backoff := time.Second
	for ctx.Err() == nil {
		err := h.Ephemeral.Subscribe(ctx, func(ev events.Event) {
			backoff = time.Second
			h.broadcast(ev)
		})
		if err != nil && ctx.Err() == nil {
			h.Logger.Warn("ephemeral events unavailable", "error", err)
			sleep(ctx, &backoff)
		}
	}
}

// Run follows the log until ctx ends. When reading fails it retries from the
// last event it saw; if events were trimmed in between, every client is told
// to resync.
func (h *Hub) Run(ctx context.Context) {
	var after events.ID
	started := false
	backoff := time.Second
	for ctx.Err() == nil {
		st, err := h.Log.State(ctx)
		if err != nil {
			h.Logger.Warn("event log unavailable", "error", err)
			sleep(ctx, &backoff)
			continue
		}
		switch {
		case !started:
			after, started = st.Last, true
		case !st.Complete(after):
			h.Logger.Warn("events lost while the log was unavailable; clients resync")
			h.resyncAll()
			after = st.Last
		}
		last, err := h.Log.Follow(ctx, after, func(ev events.Event) {
			backoff = time.Second
			h.broadcast(ev)
		})
		after = last
		if err != nil && ctx.Err() == nil {
			h.Logger.Warn("following the event log failed", "error", err)
			sleep(ctx, &backoff)
		}
	}
}

func sleep(ctx context.Context, backoff *time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(*backoff):
	}
	*backoff = min(*backoff*2, 30*time.Second)
}

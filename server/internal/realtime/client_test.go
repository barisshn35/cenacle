// SPDX-License-Identifier: AGPL-3.0-only

package realtime

import (
	"testing"

	"github.com/Cenacle-TR/cenacle/server/internal/events"
)

func TestSlowClientIsMarkedNotBlocking(t *testing.T) {
	c := newClient(2)
	for range 5 { // the hub must never block on a full queue
		c.deliver(prepare(events.Event{ID: "1-0"}))
	}
	select {
	case <-c.slow:
	default:
		t.Fatal("a client with a full queue is marked slow")
	}
	if len(c.queue) != 2 {
		t.Errorf("queue holds %d events", len(c.queue))
	}
	c.requestResync()
	c.requestResync() // coalesced, never blocks
	if len(c.resync) != 1 {
		t.Errorf("resync requests = %d", len(c.resync))
	}
}

// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/barisshn35/cenacle/server/internal/api"
)

// fedPair is a channel of one server shared with (and accepted on) another.
type fedPair struct {
	a, b          *stack
	admin, author string
	general       string // the channel on a
	mirror        string // the channel on b
	aConn, bConn  string // each side's connection
}

func newFedPair(t *testing.T) fedPair {
	t.Helper()
	sh := newShared(t)
	p := fedPair{a: newStack(t, sh, options{}), b: newStack(t, sh, options{})}
	p.admin = p.a.admin()
	p.author = p.a.user("sub-fed-author", "Author")
	p.general = p.a.general(p.author)
	bws := p.b.newWorkspace(p.admin, "Peer")
	var inv struct{ Code string }
	p.a.call(http.MethodPost, "/api/workspaces/"+p.a.defaultWS+"/federation/invites", p.admin, map[string]any{"name": "Peer"}, &inv)
	var bc api.FederationConnection
	if r := p.b.call(http.MethodPost, "/api/workspaces/"+bws+"/federation/connections", p.admin, map[string]any{"code": inv.Code, "name": "A"}, &bc); r.StatusCode != http.StatusCreated {
		t.Fatalf("connect = %d", r.StatusCode)
	}
	p.bConn = bc.Id.String()
	var fa federation
	p.a.call(http.MethodGet, "/api/workspaces/"+p.a.defaultWS+"/federation", p.admin, nil, &fa)
	p.aConn = fa.Connections[0].Id.String()
	p.a.call(http.MethodPost, "/api/channels/"+p.general+"/shares", p.admin, map[string]any{"connection_id": p.aConn}, nil)
	federate(t, p.a, p.b)
	var fb federation
	p.b.call(http.MethodGet, "/api/workspaces/"+bws+"/federation", p.admin, nil, &fb)
	var mirror api.Channel
	if r := p.b.call(http.MethodPost, "/api/federation/offers/"+fb.Offers[0].Id.String()+"/accept", p.admin, nil, &mirror); r.StatusCode != http.StatusCreated {
		t.Fatalf("accept = %d", r.StatusCode)
	}
	p.mirror = mirror.Id.String()
	federate(t, p.a, p.b)
	return p
}

// pauseOnB pauses (or resumes) the connection on the receiving side, so a's
// deliveries fail (or go through).
func (p fedPair) pauseOnB(paused bool) {
	p.b.call(http.MethodPatch, "/api/federation/connections/"+p.bConn, p.admin, map[string]any{"enabled": !paused}, nil)
}

// retryNow makes a's waiting deliveries due.
func (p fedPair) retryNow(t *testing.T) {
	t.Helper()
	if _, err := p.a.pool.Exec(context.Background(), `UPDATE federation_deliveries SET next_attempt_at = now() WHERE connection_id = $1`, p.aConn); err != nil {
		t.Fatal(err)
	}
}

// queued counts a's deliveries over the connection (of a type, or all).
func (p fedPair) queued(typ string) int {
	return p.a.count(`SELECT count(*) FROM federation_deliveries WHERE connection_id = $1 AND ($2 = '' OR event->>'type' = $2)`, p.aConn, typ)
}

// A connection's events arrive in the order they were made: a deletion queued
// while the message's creation waits for its retry does not overtake it (so
// the other server never shows a message deleted here).
func TestFederationKeepsOrder(t *testing.T) {
	p := newFedPair(t)
	p.pauseOnB(true)
	m, res := p.a.send(p.author, p.general, "withdrawn before it got there", "fed-order-0001")
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("send = %d", res.StatusCode)
	}
	federate(t, p.a, p.b) // refused there: backed off
	if n := p.a.count(`SELECT count(*) FROM federation_deliveries WHERE connection_id = $1 AND next_attempt_at > now()`, p.aConn); n != 1 {
		t.Fatalf("backed-off deliveries = %d", n)
	}

	p.pauseOnB(false)
	if r := p.a.call(http.MethodDelete, "/api/channels/"+p.general+"/messages/"+m.ID, p.author, nil, nil); r.StatusCode != http.StatusNoContent {
		t.Fatalf("delete = %d", r.StatusCode)
	}
	federate(t, p.a, p.b)
	if n := p.queued("message.deleted"); n != 1 {
		t.Fatalf("the deletion went ahead of the creation (queued: %d)", n)
	}

	// The retry is due: both go, in order.
	p.retryNow(t)
	federate(t, p.a, p.b)
	if n := p.queued(""); n != 0 {
		t.Fatalf("deliveries left = %d", n)
	}
	for _, x := range p.b.timeline(p.admin, p.mirror) {
		if strings.Contains(x.Body, "withdrawn") {
			t.Fatalf("the other server shows the deleted message: %+v", x)
		}
	}
}

// Only one sender works on a connection at a time.
func TestFederationOneSenderPerConnection(t *testing.T) {
	p := newFedPair(t)
	ctx := context.Background()
	tx, err := p.a.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var locked bool
	if err := tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock(hashtextextended(current_schema() || '.federation-send:' || $1::uuid::text, 0))`, p.aConn).Scan(&locked); err != nil || !locked {
		t.Fatalf("lock = %v %v", locked, err)
	}
	if _, res := p.a.send(p.author, p.general, "hello", "fed-lock-0001"); res.StatusCode != http.StatusCreated {
		t.Fatalf("send = %d", res.StatusCode)
	}
	if n, err := p.a.federation.Run(ctx); err != nil || n != 0 {
		t.Fatalf("sent while another sender holds the connection: %d %v", n, err)
	}
	_ = tx.Rollback(ctx)
	if n, err := p.a.federation.Run(ctx); err != nil || n != 1 {
		t.Fatalf("sent = %d %v", n, err)
	}
}

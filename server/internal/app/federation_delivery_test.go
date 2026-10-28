// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/chat"
	"github.com/barisshn35/cenacle/server/internal/integrations/signing"
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

// postSigned sends a signed request to b's events endpoint as a would.
func (p fedPair) postSigned(t *testing.T, header string, body []byte) int {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, p.b.srv.URL+"/api/federation/v1/events", bytes.NewReader(body))
	req.Header.Set(chat.FederationHeader, header)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	return res.StatusCode
}

// A signed request is taken once; the same request again (captured and
// replayed while its time is valid) is refused.
func TestFederationRefusesReplays(t *testing.T) {
	p := newFedPair(t)
	var secret string
	if err := p.a.pool.QueryRow(context.Background(), `SELECT secret FROM federation_connections WHERE id = $1`, p.bConn).Scan(&secret); err != nil {
		t.Fatal(err)
	}
	body := []byte(`{"events":[]}`)
	now := time.Now()
	header := "c=" + p.bConn + "," + signing.Sign(secret, now, body)
	if status := p.postSigned(t, header, body); status != http.StatusNoContent {
		t.Fatalf("first = %d", status)
	}
	if status := p.postSigned(t, header, body); status != http.StatusConflict {
		t.Fatalf("replay = %d", status)
	}
	// Extra fields do not make it another request.
	if status := p.postSigned(t, header+",x=1", body); status != http.StatusConflict {
		t.Fatalf("replay with an extra field = %d", status)
	}
	// Signed anew, the same body goes through.
	if status := p.postSigned(t, "c="+p.bConn+","+signing.Sign(secret, now.Add(-time.Second), body), body); status != http.StatusNoContent {
		t.Fatalf("signed anew = %d", status)
	}
}

// A repeated creation of a message the other server has deleted since (its
// answer to the first delivery was lost) is dropped there, not refused: the
// connection's later events still arrive.
func TestFederationRepeatOfDeletedMessage(t *testing.T) {
	p := newFedPair(t)
	ctx := context.Background()
	m, res := p.a.send(p.author, p.general, "first", "fed-repeat-0001")
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("send = %d", res.StatusCode)
	}
	federate(t, p.a, p.b)
	got := p.b.timeline(p.admin, p.mirror)
	if len(got) != 1 {
		t.Fatalf("mirror = %+v", got)
	}
	if r := p.b.call(http.MethodDelete, "/api/channels/"+p.mirror+"/messages/"+got[0].Id.String(), p.admin, nil, nil); r.StatusCode != http.StatusNoContent {
		t.Fatalf("delete there = %d", r.StatusCode)
	}

	// The creation again, as a retry would send it.
	var author string
	if err := p.a.pool.QueryRow(ctx, `SELECT author_id::text FROM messages WHERE id = $1`, m.ID).Scan(&author); err != nil {
		t.Fatal(err)
	}
	ev, _ := json.Marshal(map[string]any{"type": "message.created", "channel_id": p.mirror, "body": "first",
		"message": map[string]string{"ours": m.ID}, "author": map[string]string{"id": author, "name": "Author"}})
	if _, err := p.a.pool.Exec(ctx, `INSERT INTO federation_deliveries (connection_id, event) VALUES ($1, $2)`, p.aConn, ev); err != nil {
		t.Fatal(err)
	}
	if _, res := p.a.send(p.author, p.general, "second", "fed-repeat-0002"); res.StatusCode != http.StatusCreated {
		t.Fatalf("send = %d", res.StatusCode)
	}
	federate(t, p.a, p.b)
	if n := p.queued(""); n != 0 {
		t.Fatalf("deliveries left = %d (the repeat holds up the connection)", n)
	}
	got = p.b.timeline(p.admin, p.mirror)
	if len(got) != 1 || got[0].Body != "second" {
		t.Fatalf("mirror = %+v", got)
	}
}

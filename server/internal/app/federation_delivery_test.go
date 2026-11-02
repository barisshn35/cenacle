// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
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

// A connection's events arrive in the order they were made: an edit queued
// while the message's creation waits for its retry does not overtake it, and a
// message deleted meanwhile is taken out of the queue (so the other server
// never shows a message deleted here).
func TestFederationKeepsOrder(t *testing.T) {
	p := newFedPair(t)
	p.pauseOnB(true)
	m, res := p.a.send(p.author, p.general, "first draft", "fed-order-0001")
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("send = %d", res.StatusCode)
	}
	w, _ := p.a.send(p.author, p.general, "withdrawn before it got there", "fed-order-0002")
	federate(t, p.a, p.b) // refused there: backed off
	if n := p.a.count(`SELECT count(*) FROM federation_deliveries WHERE connection_id = $1 AND next_attempt_at > now()`, p.aConn); n != 2 {
		t.Fatalf("backed-off deliveries = %d", n)
	}

	p.pauseOnB(false)
	if r := p.a.call(http.MethodPatch, "/api/channels/"+p.general+"/messages/"+m.ID, p.author, map[string]string{"body": "final text"}, nil); r.StatusCode != http.StatusOK {
		t.Fatalf("edit = %d", r.StatusCode)
	}
	if r := p.a.call(http.MethodDelete, "/api/channels/"+p.general+"/messages/"+w.ID, p.author, nil, nil); r.StatusCode != http.StatusNoContent {
		t.Fatalf("delete = %d", r.StatusCode)
	}
	federate(t, p.a, p.b)
	if n := p.queued("message.updated"); n != 1 {
		t.Fatalf("the edit went ahead of the creation (queued: %d)", n)
	}
	if n := p.queued("message.created"); n != 1 {
		t.Fatalf("queued creations = %d (the deleted one stays queued)", n)
	}

	// The retry is due: all go, in order.
	p.retryNow(t)
	federate(t, p.a, p.b)
	if n := p.queued(""); n != 0 {
		t.Fatalf("deliveries left = %d", n)
	}
	edited := false
	for _, x := range p.b.timeline(p.admin, p.mirror) {
		if strings.Contains(x.Body, "withdrawn") {
			t.Fatalf("the other server shows the deleted message: %+v", x)
		}
		edited = edited || x.Body == "final text"
	}
	if !edited {
		t.Error("the other server does not show the edit")
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
	return postEvents(t, p.b, header, body)
}

func postEvents(t *testing.T, to *stack, header string, body []byte) int {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, to.srv.URL+"/api/federation/v1/events", bytes.NewReader(body))
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
	header := signV2(secret, p.bConn, "events", now, body)
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
	if status := p.postSigned(t, signV2(secret, p.bConn, "events", now.Add(-time.Second), body), body); status != http.StatusNoContent {
		t.Fatalf("signed anew = %d", status)
	}
}

// signV2 signs a request the way servers since 0.99.2 do.
func signV2(secret, connection, endpoint string, at time.Time, body []byte) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte("v2." + strconv.FormatInt(at.Unix(), 10) + "." + connection + "." + endpoint + "."))
	m.Write(body)
	return "c=" + connection + "," + signing.Sign(secret, at, body) + ",v2=" + hex.EncodeToString(m.Sum(nil))
}

// v2 signatures bind a request to its connection: one signed for b's side of
// the connection cannot be turned back to a (the two sides share the secret).
// Once a server signs with v2, requests without it are refused; servers that
// never did (before 0.99.2) still get through with v1.
func TestFederationSignatureV2(t *testing.T) {
	p := newFedPair(t)
	ctx := context.Background()
	version := func(conn string) int {
		return p.a.count(`SELECT signature_version FROM federation_connections WHERE id = $1`, conn)
	}
	if va, vb := version(p.aConn), version(p.bConn); va != 2 || vb != 2 {
		t.Fatalf("signature versions = %d %d", va, vb)
	}
	var secret string
	if err := p.a.pool.QueryRow(ctx, `SELECT secret FROM federation_connections WHERE id = $1`, p.bConn).Scan(&secret); err != nil {
		t.Fatal(err)
	}
	body := []byte(`{"events":[]}`)
	now := time.Now()

	// Signed for b, sent to a under a's connection id.
	header := signV2(secret, p.bConn, "events", now, body)
	turned := "c=" + p.aConn + header[strings.Index(header, ","):]
	if status := postEvents(t, p.a, turned, body); status != http.StatusUnauthorized {
		t.Errorf("turned back = %d", status)
	}
	// v2 stripped off.
	if status := postEvents(t, p.b, header[:strings.Index(header, ",v2=")], body); status != http.StatusUnauthorized {
		t.Errorf("without v2 = %d", status)
	}
	if status := postEvents(t, p.b, header, body); status != http.StatusNoContent {
		t.Errorf("signed = %d", status)
	}

	// A server before v2: v1 only, still taken (and not pinned).
	if _, err := p.a.pool.Exec(ctx, `UPDATE federation_connections SET signature_version = 1 WHERE id = $1`, p.bConn); err != nil {
		t.Fatal(err)
	}
	if status := postEvents(t, p.b, "c="+p.bConn+","+signing.Sign(secret, now.Add(-time.Second), body), body); status != http.StatusNoContent {
		t.Errorf("v1 of an old server = %d", status)
	}
	if v := version(p.bConn); v != 1 {
		t.Errorf("signature version after v1 = %d", v)
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

// A server moved back below 0.99.2 signs with v1 only: a connection that
// requires v2 refuses it and notes it (only for a valid v1 signature), and the
// workspace's admins may take v1 again, until the server next signs with v2.
func TestFederationMovedBack(t *testing.T) {
	p := newFedPair(t)
	ctx := context.Background()
	var secret, bws string
	if err := p.a.pool.QueryRow(ctx, `SELECT secret, workspace_id::text FROM federation_connections WHERE id = $1`, p.bConn).Scan(&secret, &bws); err != nil {
		t.Fatal(err)
	}
	connection := func() api.FederationConnection {
		t.Helper()
		var f federation
		p.b.call(http.MethodGet, "/api/workspaces/"+bws+"/federation", p.admin, nil, &f)
		for _, c := range f.Connections {
			if c.Id.String() == p.bConn {
				return c
			}
		}
		t.Fatal("no connection")
		return api.FederationConnection{}
	}
	if c := connection(); !c.RequiresV2 || c.V1RefusedAt != nil {
		t.Fatalf("before = %+v", c)
	}
	created, _ := json.Marshal(map[string]any{"type": "message.created", "channel_id": p.mirror, "body": "sent by an older server",
		"message": map[string]string{"ours": "0199b0a0-0000-7000-8000-000000000001"},
		"author":  map[string]string{"id": "0199b0a0-0000-7000-8000-0000000000a1", "name": "Author"}})
	body := []byte(`{"events":[` + string(created) + `]}`)
	v1 := func(secret string, at time.Time, body []byte) string {
		return "c=" + p.bConn + "," + signing.Sign(secret, at, body)
	}
	now := time.Now()

	// Not signed with the connection's secret: refused, and nothing noted.
	if status := p.postSigned(t, v1("forged", now, body), body); status != http.StatusUnauthorized {
		t.Fatalf("forged = %d", status)
	}
	if c := connection(); c.V1RefusedAt != nil {
		t.Fatalf("a forged request marked the server moved back: %+v", c)
	}
	// Signed with v1 only: refused, and noted.
	if status := p.postSigned(t, v1(secret, now, body), body); status != http.StatusUnauthorized {
		t.Fatalf("v1 while v2 is required = %d", status)
	}
	if c := connection(); !c.RequiresV2 || c.V1RefusedAt == nil {
		t.Fatalf("after v1 = %+v", c)
	}

	// Only the workspace's owners and admins take v1 again.
	accept := "/api/federation/connections/" + p.bConn + "/accept-v1"
	member := p.b.user("sub-fed-member", "Member")
	if _, err := p.b.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id, user_id)
		SELECT $1, id FROM users WHERE auth_data = 'sub-fed-member'`, bws); err != nil {
		t.Fatal(err)
	}
	if status, _ := problemCode(t, p.b, http.MethodPost, accept, member, nil); status != http.StatusForbidden {
		t.Errorf("member accepts v1 = %d", status)
	}
	var c api.FederationConnection
	if res := p.b.call(http.MethodPost, accept, p.admin, nil, &c); res.StatusCode != http.StatusOK || c.RequiresV2 || c.V1RefusedAt != nil {
		t.Fatalf("accept v1 = %d %+v", res.StatusCode, c)
	}
	if n := p.b.count(`SELECT count(*) FROM audit_events WHERE workspace_id = $1 AND action = 'federation.changed' AND detail->>'change' = 'v1_accepted'`, bws); n != 1 {
		t.Errorf("audit entries = %d", n)
	}
	// The held-up event, signed anew, now goes through.
	if status := p.postSigned(t, v1(secret, now.Add(-time.Second), body), body); status != http.StatusNoContent {
		t.Fatalf("v1 after accepting it = %d", status)
	}
	if got := p.b.timeline(p.admin, p.mirror); len(got) != 1 || got[0].Body != "sent by an older server" {
		t.Fatalf("mirror = %+v", got)
	}
	if c := connection(); c.RequiresV2 || c.V1RefusedAt != nil {
		t.Fatalf("after taking v1 = %+v", c)
	}
	// Moved forward again: the first v2 request requires v2 once more.
	empty := []byte(`{"events":[]}`)
	if status := p.postSigned(t, signV2(secret, p.bConn, "events", now, empty), empty); status != http.StatusNoContent {
		t.Fatalf("v2 = %d", status)
	}
	if c := connection(); !c.RequiresV2 || c.V1RefusedAt != nil {
		t.Fatalf("after v2 = %+v", c)
	}
	if status := p.postSigned(t, v1(secret, now.Add(-2*time.Second), empty), empty); status != http.StatusUnauthorized {
		t.Fatalf("v1 after v2 again = %d", status)
	}
}

// Pausing a connection holds its events until it resumes: a deletion or edit
// made meanwhile still reaches the other server, and a message deleted while
// its creation waited never shows there.
func TestFederationPausedConnectionKeepsChanges(t *testing.T) {
	p := newFedPair(t)
	pauseOnA := func(paused bool) {
		if res := p.a.call(http.MethodPatch, "/api/federation/connections/"+p.aConn, p.admin, map[string]any{"enabled": !paused}, nil); res.StatusCode != http.StatusOK {
			t.Fatalf("pause = %d", res.StatusCode)
		}
	}
	delivered, _ := p.a.send(p.author, p.general, "PAUSE-DELIVERED", "fed-pause-1")
	edited, _ := p.a.send(p.author, p.general, "PAUSE-BEFORE-EDIT", "fed-pause-2")
	federate(t, p.a, p.b)

	pauseOnA(true)
	p.a.call(http.MethodDelete, "/api/channels/"+p.general+"/messages/"+delivered.ID, p.author, nil, nil)
	p.a.call(http.MethodPatch, "/api/channels/"+p.general+"/messages/"+edited.ID, p.author, map[string]string{"body": "PAUSE-AFTER-EDIT"}, nil)
	federate(t, p.a, p.b) // nothing goes while paused
	if q := p.queued(""); q != 2 {
		t.Fatalf("queued while paused = %d", q)
	}
	pauseOnA(false)
	federate(t, p.a, p.b)

	// The creation waits for its retry when the pause starts.
	p.pauseOnB(true)
	waiting, _ := p.a.send(p.author, p.general, "PAUSE-WAITING", "fed-pause-3")
	federate(t, p.a, p.b)
	pauseOnA(true)
	p.a.call(http.MethodDelete, "/api/channels/"+p.general+"/messages/"+waiting.ID, p.author, nil, nil)
	pauseOnA(false)
	p.pauseOnB(false)
	p.retryNow(t)
	federate(t, p.a, p.b)

	if q := p.queued(""); q != 0 {
		t.Fatalf("deliveries left = %d", q)
	}
	var bodies []string
	for _, x := range p.b.timeline(p.admin, p.mirror) {
		bodies = append(bodies, x.Body)
	}
	all := strings.Join(bodies, "|")
	if strings.Contains(all, "PAUSE-DELIVERED") || strings.Contains(all, "PAUSE-WAITING") || strings.Contains(all, "PAUSE-BEFORE-EDIT") ||
		!strings.Contains(all, "PAUSE-AFTER-EDIT") {
		t.Errorf("the other server shows %q", bodies)
	}
}

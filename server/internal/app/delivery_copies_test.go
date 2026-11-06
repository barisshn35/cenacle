// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/testdb"
	"github.com/Cenacle-TR/cenacle/server/migrations"
)

// Migration 00056 rolls back and applies again.
func TestDeliveryCopiesMigrationDown(t *testing.T) {
	pool := testdb.Open(t)
	raw, err := migrations.FS.ReadFile("00056_delivery_message_copies.sql")
	if err != nil {
		t.Fatal(err)
	}
	up, down, _ := strings.Cut(string(raw), "-- +goose Down")
	for _, sql := range []string{down, up} {
		if _, err := pool.Exec(context.Background(), sql); err != nil {
			t.Fatal(err)
		}
	}
}

// subscribedBot makes a bot in general subscribed to events, sending to a receiver.
func (s *stack) subscribedBot(admin, general string, events ...string) (bot, *receiver) {
	s.t.Helper()
	b := s.newBot(admin, "Hook")
	rv := newReceiver(s.t)
	if res := s.call(http.MethodPost, "/api/bots/"+b.ID+"/subscriptions", admin, map[string]any{"url": rv.URL, "events": events}, nil); res.StatusCode != http.StatusCreated {
		s.t.Fatalf("subscribe = %d", res.StatusCode)
	}
	s.call(http.MethodPost, "/api/channels/"+general+"/members", admin, map[string]string{"user_id": b.UserID}, nil)
	return b, rv
}

// deliveriesDue makes the waiting bot deliveries due and sends them.
func (s *stack) deliveriesDue() {
	s.t.Helper()
	ctx := context.Background()
	if _, err := s.pool.Exec(ctx, `UPDATE event_deliveries SET next_attempt_at = now() WHERE status = 'pending'`); err != nil {
		s.t.Fatal(err)
	}
	if _, err := s.bg.DeliverDue(ctx); err != nil {
		s.t.Fatal(err)
	}
}

// receivedWith counts what a receiver got that contains a text.
func receivedWith(rv *receiver, text string) int {
	n := 0
	for _, g := range rv.received() {
		if strings.Contains(string(g.body), text) {
			n++
		}
	}
	return n
}

// deliveryOf returns the id of a stored delivery that contains a text.
func (s *stack) deliveryOf(text string) string {
	s.t.Helper()
	var id string
	if err := s.pool.QueryRow(context.Background(), `SELECT id::text FROM event_deliveries WHERE payload::text LIKE '%' || $1 || '%' ORDER BY id LIMIT 1`, text).Scan(&id); err != nil {
		s.t.Fatal(err)
	}
	return id
}

// A spillage removal reaches the bot deliveries that carry the text: the
// pending ones are not sent, the sent ones cannot be sent again, forwarded
// snapshots in them are emptied, and reminders already sent are removed.
func TestSpillageRemovesBotDeliveries(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	owner := s.admin()
	a := s.user("sub-a", "Ayşe")
	b := s.user("sub-b", "Barış")
	general := s.general(a)
	s.general(b)
	bt, rv := s.subscribedBot(owner, general, "message.created", "message.updated")
	const marker = "SPILL-DELIVERY-7"

	m, _ := s.send(a, general, "token "+marker, "spill-delivery-1")
	s.deliveriesDue() // sent
	sent := s.deliveryOf(marker)
	rv.set(http.StatusServiceUnavailable, "")
	s.call(http.MethodPatch, "/api/channels/"+general+"/messages/"+m.ID, a, map[string]string{"body": "token " + marker + " (edited)"}, nil)
	if res := s.call(http.MethodPost, "/api/channels/"+general+"/messages/"+m.ID+"/forward", b,
		map[string]any{"channel_id": general, "comment": "fyi"}, nil); res.StatusCode != http.StatusCreated {
		t.Fatalf("forward = %d", res.StatusCode)
	}
	s.deliveriesDue() // refused: both wait for their retry
	if s.count(`SELECT count(*) FROM event_deliveries WHERE status = 'pending'`) != 2 {
		t.Fatalf("pending = %d", s.count(`SELECT count(*) FROM event_deliveries WHERE status = 'pending'`))
	}
	// A saved copy whose reminder was sent already.
	s.call(http.MethodPut, "/api/me/saved/"+m.ID, b, map[string]any{"remind_at": time.Now().Add(time.Hour).Truncate(time.Second)}, nil)
	ctx := context.Background()
	_, _ = s.pool.Exec(ctx, `UPDATE scheduled_messages SET send_at = now() - interval '1 minute' WHERE status = 'pending'`)
	if _, err := s.bg.SendDueScheduled(ctx); err != nil {
		t.Fatal(err)
	}
	if s.count(`SELECT count(*) FROM messages WHERE body LIKE '%' || $1 || '%' AND deleted_at IS NULL`, marker) != 2 {
		t.Fatal("the reminder was not sent")
	}

	var rep api.SpillageReport
	s.call(http.MethodPost, "/api/channels/"+general+"/messages/"+m.ID+"/spillage", b, map[string]string{"reason": "secret"}, &rep)
	if res := s.call(http.MethodPost, "/api/spillage/"+rep.Id.String()+"/decision", owner, map[string]string{"decision": "remove"}, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("decide = %d", res.StatusCode)
	}
	if n := s.count(`SELECT count(*) FROM event_deliveries WHERE payload::text LIKE '%' || $1 || '%'`, marker); n != 0 {
		t.Errorf("%d deliveries keep the text", n)
	}
	if n := s.count(`SELECT count(*) FROM messages WHERE body LIKE '%' || $1 || '%'`, marker); n != 0 {
		t.Errorf("%d messages keep the text (sent reminder)", n)
	}
	if n := s.count(`SELECT count(*) FROM scheduled_messages WHERE body LIKE '%' || $1 || '%'`, marker); n != 0 {
		t.Errorf("%d reminders keep the text", n)
	}
	if status, _ := problemCode(t, s, http.MethodPost, "/api/bots/"+bt.ID+"/deliveries/"+sent+"/resend", owner, nil); status != http.StatusNotFound {
		t.Errorf("resend of the removed message = %d", status)
	}
	before := receivedWith(rv, marker)
	rv.set(http.StatusOK, "")
	s.deliveriesDue()
	if n := receivedWith(rv, marker) - before; n != 0 {
		t.Errorf("%d deliveries sent the removed text", n)
	}
	var incident struct {
		Removed struct {
			SentReminders    int `json:"sent_reminders"`
			BotDeliveries    int `json:"bot_deliveries"`
			ServerDeliveries int `json:"server_deliveries"`
		}
	}
	_ = s.pool.QueryRow(ctx, `SELECT report FROM spillage_reports WHERE id = $1`, rep.Id.String()).Scan(&incident)
	if incident.Removed.SentReminders != 1 || incident.Removed.BotDeliveries != 3 {
		t.Errorf("incident counts = %+v", incident.Removed)
	}
}

// Deleting a message (and erasing its author) takes its bot deliveries along:
// a waiting one is not sent, a sent one cannot be sent again, and the erased
// person's name stays in none of them.
func TestDeletionRemovesBotDeliveries(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	a := s.user("sub-a", "Ayşe")
	c := s.user("sub-c", "Cemre")
	general := s.general(a)
	s.general(c)
	bt, rv := s.subscribedBot(admin, general, "message.created", "message.deleted", "reaction.added")

	// Deleted after it was sent; and deleted while it waits for a retry.
	m, _ := s.send(a, general, "DELETED-AFTER-SEND", "deleted-1")
	s.deliveriesDue()
	sent := s.deliveryOf("DELETED-AFTER-SEND")
	rv.set(http.StatusServiceUnavailable, "")
	w, _ := s.send(a, general, "DELETED-WHILE-WAITING", "deleted-2")
	s.deliveriesDue()
	for _, id := range []string{m.ID, w.ID} {
		if res := s.call(http.MethodDelete, "/api/channels/"+general+"/messages/"+id, a, nil, nil); res.StatusCode != http.StatusNoContent {
			t.Fatalf("delete = %d", res.StatusCode)
		}
	}
	if status, _ := problemCode(t, s, http.MethodPost, "/api/bots/"+bt.ID+"/deliveries/"+sent+"/resend", admin, nil); status != http.StatusNotFound {
		t.Errorf("resend of a deleted message = %d", status)
	}
	before := receivedWith(rv, "DELETED-WHILE-WAITING") // the refused attempt
	rv.set(http.StatusOK, "")
	s.deliveriesDue()
	if n := receivedWith(rv, "DELETED-WHILE-WAITING") - before; n != 0 {
		t.Errorf("a deleted message went out %d times", n)
	}
	if n := s.count(`SELECT count(*) FROM event_deliveries WHERE event_type = 'message.deleted'`); n != 2 {
		t.Errorf("deletions queued = %d", n)
	}

	// Erasure: also what a legal hold keeps, and the person's reactions.
	held, _ := s.send(c, general, "ERASED-HELD-BODY", "erased-1")
	s.call(http.MethodPut, "/api/channels/"+general+"/messages/"+held.ID+"/reactions/%F0%9F%91%8D", c, nil, nil)
	s.deliveriesDue()
	if res := s.call(http.MethodPost, "/api/workspaces/"+s.defaultWS+"/legal-holds", admin, map[string]any{
		"name": "Case", "user_ids": []string{}, "channel_ids": []string{general},
	}, nil); res.StatusCode != http.StatusCreated {
		t.Fatalf("hold = %d", res.StatusCode)
	}
	cID := s.userID(c)
	var name string
	_ = s.pool.QueryRow(context.Background(), `SELECT display_name FROM users WHERE id = $1`, cID).Scan(&name)
	if res := s.call(http.MethodPost, "/api/admin/users/"+cID+"/erase", admin, map[string]string{"confirm": name}, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("erase = %d", res.StatusCode)
	}
	if n := s.count(`SELECT count(*) FROM event_deliveries WHERE payload::text LIKE '%ERASED-HELD-BODY%' OR payload::text LIKE '%' || $1 || '%' OR payload ->> 'user_id' = $2`, name, cID); n != 0 {
		t.Errorf("%d deliveries keep the erased person's messages or name", n)
	}
}

// A disabled bot, or one taken out of the channel, gets nothing more: neither
// what waits for a retry nor what an admin sends again.
func TestRevokedBotGetsNoDeliveries(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	a := s.user("sub-a", "Ayşe")
	general := s.general(a)
	bt, rv := s.subscribedBot(admin, general, "message.created")

	rv.set(http.StatusServiceUnavailable, "")
	s.send(a, general, "REVOKED-DISABLED", "revoked-1")
	s.deliveriesDue()
	waiting := s.deliveryOf("REVOKED-DISABLED")
	s.call(http.MethodPatch, "/api/bots/"+bt.ID, admin, map[string]bool{"disabled": true}, nil)
	rv.set(http.StatusOK, "")
	s.deliveriesDue()
	if n := receivedWith(rv, "REVOKED-DISABLED"); n != 1 { // the refused first attempt only
		t.Errorf("a disabled bot got %d deliveries", n)
	}
	if st := s.count(`SELECT count(*) FROM event_deliveries WHERE id = $1 AND status = 'failed'`, waiting); st != 1 {
		t.Error("the waiting delivery did not fail")
	}
	if status, code := problemCode(t, s, http.MethodPost, "/api/bots/"+bt.ID+"/deliveries/"+waiting+"/resend", admin, nil); status != http.StatusConflict || code != "delivery_not_sendable" {
		t.Errorf("resend for a disabled bot = %d %s", status, code)
	}

	s.call(http.MethodPatch, "/api/bots/"+bt.ID, admin, map[string]bool{"disabled": false}, nil)
	s.send(a, general, "REVOKED-REMOVED", "revoked-2")
	if res := s.call(http.MethodDelete, "/api/channels/"+general+"/members/"+bt.UserID, admin, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("remove bot = %d", res.StatusCode)
	}
	s.deliveriesDue()
	if n := receivedWith(rv, "REVOKED-REMOVED"); n != 0 {
		t.Errorf("a bot out of the channel got %d deliveries", n)
	}
	if status, _ := problemCode(t, s, http.MethodPost, "/api/bots/"+bt.ID+"/deliveries/"+s.deliveryOf("REVOKED-REMOVED")+"/resend", admin, nil); status != http.StatusConflict {
		t.Errorf("resend for a bot out of the channel = %d", status)
	}
}

// A spillage removal reaches the events still queued for other servers: the
// removed text is neither kept in the queue nor sent once the server is back.
func TestFederationSpillageDropsQueuedEvents(t *testing.T) {
	p := newFedPair(t)
	const marker = "FED-SPILL-MARKER"
	p.pauseOnB(true)
	m, _ := p.a.send(p.author, p.general, "harmless", "fed-spill-1")
	federate(t, p.a, p.b) // refused there: backed off
	p.a.call(http.MethodPatch, "/api/channels/"+p.general+"/messages/"+m.ID, p.author, map[string]string{"body": "edit " + marker}, nil)
	n, _ := p.a.send(p.author, p.general, "created "+marker, "fed-spill-2")
	for _, id := range []string{m.ID, n.ID} {
		var rep api.SpillageReport
		p.a.call(http.MethodPost, "/api/channels/"+p.general+"/messages/"+id+"/spillage", p.author, map[string]string{"reason": "secret"}, &rep)
		if res := p.a.call(http.MethodPost, "/api/spillage/"+rep.Id.String()+"/decision", p.admin, map[string]string{"decision": "remove"}, nil); res.StatusCode != http.StatusOK {
			t.Fatalf("decide = %d", res.StatusCode)
		}
	}
	if q := p.a.count(`SELECT count(*) FROM federation_deliveries WHERE event::text LIKE '%' || $1 || '%'`, marker); q != 0 {
		t.Errorf("%d queued events keep the removed text", q)
	}
	p.pauseOnB(false)
	p.retryNow(t)
	federate(t, p.a, p.b)
	if q := p.queued(""); q != 0 {
		t.Fatalf("deliveries left = %d", q)
	}
	if n := p.b.count(`SELECT count(*) FROM messages WHERE body LIKE '%' || $1 || '%'`, marker); n != 0 {
		t.Errorf("the other server stores the removed text in %d messages", n)
	}
}

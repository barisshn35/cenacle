// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/barisshn35/cenacle/server/internal/testdb"
	"github.com/barisshn35/cenacle/server/migrations"
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

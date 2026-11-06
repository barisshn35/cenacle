// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/chat"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

func TestMessagePriority(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ayse := s.user("sub-a", "Ayşe")
	mert := s.user("sub-m", "Mert")
	general := s.general(ayse)
	post := func(token string, body map[string]any) (api.Message, int) {
		var m api.Message
		res := s.call(http.MethodPost, "/api/channels/"+general+"/messages", token, body, &m)
		return m, res.StatusCode
	}

	m, status := post(ayse, map[string]any{
		"body": "Sunucu düştü <@" + s.userID(mert) + ">", "nonce": "prio-nonce-1",
		"priority": "urgent", "request_ack": true, "persistent": true,
	})
	if status != http.StatusCreated || m.Priority == nil || *m.Priority != api.MessagePriorityUrgent ||
		m.Ack == nil || m.Ack.Count != 0 || m.Persistent == nil || !*m.Persistent {
		t.Fatalf("urgent = %d %+v", status, m)
	}
	for name, body := range map[string]map[string]any{
		"persistent without a mention": {"body": "x", "nonce": "prio-nonce-2", "priority": "urgent", "persistent": true},
		"persistent and important":     {"body": "<@" + s.userID(mert) + ">", "nonce": "prio-nonce-3", "priority": "important", "persistent": true},
		"a reply":                      {"body": "x", "nonce": "prio-nonce-4", "root_id": m.Id, "priority": "important"},
		"unknown priority":             {"body": "x", "nonce": "prio-nonce-5", "priority": "low"},
	} {
		if _, status := post(ayse, body); status != http.StatusBadRequest {
			t.Errorf("%s = %d", name, status)
		}
	}

	// Mert is reminded once it is due, not again before the next interval.
	if _, err := s.pool.Exec(context.Background(), "UPDATE messages SET created_at = now() - interval '6 minutes' WHERE id = $1", m.Id); err != nil {
		t.Fatal(err)
	}
	conn := s.connect(mert, "")
	read(t, conn) // hello
	reminders := &chat.Reminders{DB: s.pool, Queries: store.New(s.pool)}
	if n, err := reminders.Run(context.Background()); err != nil || n != 1 {
		t.Fatalf("reminders = %d %v", n, err)
	}
	ev := read(t, conn)
	var rem chat.ReminderEvent
	_ = json.Unmarshal(ev.Data, &rem)
	if ev.Type != "message.reminder" || rem.MessageID != m.Id.String() || rem.AuthorName != "Ayşe" {
		t.Errorf("reminder = %s %s", ev.Type, ev.Data)
	}
	if n, _ := reminders.Run(context.Background()); n != 0 {
		t.Errorf("reminded again at once: %d", n)
	}

	// Acknowledging: everyone in the channel learns it; reminders stop.
	path := "/api/channels/" + general + "/messages/" + m.Id.String() + "/ack"
	if res := s.call(http.MethodPut, path, mert, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("ack = %d", res.StatusCode)
	}
	if ev := read(t, conn); ev.Type != "message.ack" {
		t.Errorf("ack event = %s", ev.Type)
	}
	if _, err := s.pool.Exec(context.Background(), "UPDATE message_reminders SET last_at = now() - interval '10 minutes'"); err != nil {
		t.Fatal(err)
	}
	if n, _ := reminders.Run(context.Background()); n != 0 {
		t.Errorf("reminded after acknowledging: %d", n)
	}
	var page api.MessagePage
	s.call(http.MethodGet, "/api/channels/"+general+"/messages", ayse, nil, &page)
	got := page.Messages[len(page.Messages)-1]
	if got.Ack == nil || got.Ack.Count != 1 || got.Ack.Me || got.Ack.People[0].DisplayName != "Mert" {
		t.Errorf("listed ack = %+v", got.Ack)
	}
	if res := s.call(http.MethodDelete, path, mert, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Errorf("unack = %d", res.StatusCode)
	}
	plain, _ := s.send(ayse, general, "sıradan", "prio-nonce-6")
	if status, code := problemCode(t, s, http.MethodPut, "/api/channels/"+general+"/messages/"+plain.ID+"/ack", mert, nil); status != http.StatusConflict || code != "no_ack_requested" {
		t.Errorf("ack of a plain message = %d %s", status, code)
	}

	// The workspace can turn reminders off.
	admin := s.admin()
	var ws api.Workspace
	if res := s.call(http.MethodPatch, "/api/workspaces/"+s.defaultWS, admin, map[string]any{"persistent_notifications": false, "persistent_times": 3}, &ws); res.StatusCode != http.StatusOK ||
		*ws.PersistentNotifications || *ws.PersistentTimes != 3 {
		t.Errorf("settings = %d %+v", res.StatusCode, ws)
	}
	if _, err := s.pool.Exec(context.Background(), "DELETE FROM message_acks"); err != nil {
		t.Fatal(err)
	}
	if n, _ := reminders.Run(context.Background()); n != 0 {
		t.Errorf("reminded while turned off: %d", n)
	}
}

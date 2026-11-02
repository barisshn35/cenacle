// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/chat"
	"github.com/barisshn35/cenacle/server/internal/store"
)

func TestBurnReminderCarriesNoText(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ayse := s.user("sub-a", "Ayşe")
	mert := s.user("sub-m", "Mert")
	dm, _ := s.open(ayse, s.defaultWS, s.userID(mert))
	var m api.Message
	if res := s.call(http.MethodPost, "/api/channels/"+dm.ID+"/messages", ayse, map[string]any{
		"body": "BURN-SECRET <@" + s.userID(mert) + ">", "nonce": "burnrem-nonce-1", "burn_seconds": 30,
		"priority": "urgent", "persistent": true,
	}, &m); res.StatusCode != http.StatusCreated {
		t.Fatalf("send = %d", res.StatusCode)
	}
	if _, err := s.pool.Exec(context.Background(), "UPDATE messages SET created_at = now() - interval '6 minutes' WHERE id = $1", m.Id); err != nil {
		t.Fatal(err)
	}
	conn := s.connect(mert, "")
	read(t, conn) // hello
	reminders := &chat.Reminders{DB: s.pool, Queries: store.New(s.pool)}
	if n, err := reminders.Run(context.Background()); err != nil || n != 1 {
		t.Fatalf("reminders = %d %v", n, err)
	}
	if ev := read(t, conn); ev.Type != "message.reminder" || strings.Contains(string(ev.Data), "BURN-SECRET") {
		t.Errorf("reminder = %s %s", ev.Type, ev.Data)
	}
}

func TestHeldReplySurvivesRootPurge(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	mert := s.user("sub-m", "Mert")
	general := s.general(ayse)
	s.general(mert)
	if res := s.call(http.MethodPost, "/api/workspaces/"+s.defaultWS+"/legal-holds", admin,
		map[string]any{"name": "Case", "user_ids": []string{s.userID(mert)}, "channel_ids": []string{}}, nil); res.StatusCode != http.StatusCreated {
		t.Fatalf("hold = %d", res.StatusCode)
	}

	// The root's author deletes it; the purge runs after the restore window.
	root, _ := s.send(ayse, general, "root A", "heldreply-nonce-1")
	reply, _ := s.reply(mert, general, root.ID, "held reply A", "heldreply-nonce-2", false)
	if res := s.call(http.MethodDelete, "/api/channels/"+general+"/messages/"+root.ID, ayse, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("delete = %d", res.StatusCode)
	}
	if _, err := s.pool.Exec(context.Background(), `UPDATE messages SET deleted_at = now() - interval '30 days' WHERE id = $1`, root.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := (chat.Purger{Queries: store.New(s.pool)}).PurgeDeleted(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := s.count(`SELECT count(*) FROM messages WHERE id = $1`, reply.Id.String()); n != 1 {
		t.Error("the deleted-message purge took a held reply")
	}

	// Retention: an old root with a newer held reply.
	old, _ := s.send(ayse, general, "root B", "heldreply-nonce-3")
	old.ID = s.age(old.ID, 40)
	reply, _ = s.reply(mert, general, old.ID, "held reply B", "heldreply-nonce-4", false)
	if res := s.call(http.MethodPut, "/api/workspaces/"+s.defaultWS+"/compliance", admin, map[string]any{
		"retention_days": 30, "default_classification": nil, "classifications": []any{}, "attributes": []any{},
	}, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("retention = %d", res.StatusCode)
	}
	s.purgeExpired()
	if n := s.count(`SELECT count(*) FROM messages WHERE id = $1`, reply.Id.String()); n != 1 {
		t.Error("the retention purge took a held reply")
	}
}

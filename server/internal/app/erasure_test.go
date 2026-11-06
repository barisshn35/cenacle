// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
	"github.com/Cenacle-TR/cenacle/server/internal/testdb"
	"github.com/Cenacle-TR/cenacle/server/migrations"
)

// Erasure takes away what a person uploaded and set, tells open apps and bots
// that their messages are gone (all at once), and marks the messages a legal
// hold keeps as deleted too: they keep their text and edits for eDiscovery and
// go once the hold no longer keeps them. The export has the rest of their data.
func TestErasureLeavesNothingBehind(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ctx := context.Background()
	admin := s.admin()
	ayse := s.user("sub-erase-a", "Ayşe Kaya")
	general := s.general(ayse)
	var held struct{ ID string }
	s.call(http.MethodPost, "/api/channels", admin, map[string]any{"workspace_id": s.defaultWS, "name": "dava"}, &held)
	s.call(http.MethodPost, "/api/channels/"+held.ID+"/members", admin, map[string]any{"user_id": s.userID(ayse)}, nil)
	_, rv := s.subscribedBot(admin, general, "message.deleted")

	if res, body := s.upload(http.MethodPut, "/api/me/avatar", ayse, pngImage(t, 64, 64)); res.StatusCode != http.StatusOK {
		t.Fatalf("avatar = %d %s", res.StatusCode, body)
	}
	if res, _ := s.upload(http.MethodPost, "/api/me/fonts?name=Mine", ayse, append([]byte("wOF2"), bytes.Repeat([]byte{1}, 100)...)); res.StatusCode != http.StatusCreated {
		t.Fatalf("font = %d", res.StatusCode)
	}
	if res, _ := s.upload(http.MethodPost, "/api/me/sounds?name=Gong", ayse, append([]byte("RIFF\x24\x00\x00\x00WAVEfmt "), bytes.Repeat([]byte{0}, 40)...)); res.StatusCode != http.StatusCreated {
		t.Fatalf("sound = %d", res.StatusCode)
	}
	free, _ := s.send(ayse, general, "taslak", "erase-nonce-1")
	kept, _ := s.send(ayse, held.ID, "tanık listesi", "erase-nonce-2")
	for _, m := range []struct{ channel, id string }{{general, free.ID}, {held.ID, kept.ID}} {
		if res := s.call(http.MethodPatch, "/api/channels/"+m.channel+"/messages/"+m.id, ayse, map[string]string{"body": "düzeltildi"}, nil); res.StatusCode != http.StatusOK {
			t.Fatalf("edit = %d", res.StatusCode)
		}
	}

	_, mine := s.download(ayse, "/api/me/export")
	k := kinds(mine)
	if k["profile_picture"] != 1 || k["font"] != 1 || k["sound"] != 1 || k["message_version"] != 2 || k["appearance"] > 1 {
		t.Fatalf("export kinds = %v", k)
	}
	for _, l := range mine {
		data, _ := l["data"].(map[string]any)
		for _, secret := range []string{"token_hash", "p256dh", "auth", "secret", "password_hash"} {
			if _, ok := data[secret]; ok {
				t.Errorf("%s in the export (%s)", secret, l["kind"])
			}
		}
	}

	var hold api.LegalHold
	if res := s.call(http.MethodPost, "/api/workspaces/"+s.defaultWS+"/legal-holds", admin, map[string]any{
		"name": "Dava 9", "user_ids": []string{}, "channel_ids": []string{held.ID},
	}, &hold); res.StatusCode != http.StatusCreated {
		t.Fatalf("hold = %d", res.StatusCode)
	}
	ayseID := s.userID(ayse)
	conn := s.connect(admin, "")
	read(t, conn)
	var avatar pgtype.UUID
	if err := s.pool.QueryRow(ctx, `SELECT avatar_id FROM users WHERE id = $1`, ayseID).Scan(&avatar); err != nil || !avatar.Valid {
		t.Fatalf("avatar id = %v %v", avatar, err)
	}
	// Audit events she did, and one an administrator did about her.
	if _, err := s.pool.Exec(ctx, `INSERT INTO audit_events (actor_id, action, ip_address, detail) VALUES
		($1, 'test.hers', '192.0.2.7', '{"name": "Ayşe Kaya laptop", "channel": "dava", "address": "ayse@example.com"}'),
		($2, 'test.about', '198.51.100.9', '{"channel": "dava"}')`, ayseID, s.userID(admin)); err != nil {
		t.Fatal(err)
	}
	var counts struct {
		Erased int `json:"messages_erased"`
		Held   int `json:"messages_held"`
	}
	if res := s.call(http.MethodPost, "/api/admin/users/"+ayseID+"/erase", admin, map[string]string{"confirm": "Ayşe Kaya"}, &counts); res.StatusCode != http.StatusOK || counts.Erased != 1 || counts.Held != 1 {
		t.Fatalf("erase = %d %+v", res.StatusCode, counts)
	}

	if n := s.count(`SELECT count(*) FROM pictures WHERE id = $1`, avatar); n != 0 {
		t.Errorf("profile picture left: %d", n)
	}
	// Her events keep what happened, not her address or details; the administrator's stay.
	var ip, detail string
	if err := s.pool.QueryRow(ctx, `SELECT ip_address, detail::text FROM audit_events WHERE action = 'test.hers'`).Scan(&ip, &detail); err != nil {
		t.Fatal(err)
	}
	if ip != "" || detail != `{"channel": "dava"}` {
		t.Errorf("her audit event = %q %s", ip, detail)
	}
	if n := s.count(`SELECT count(*) FROM audit_events WHERE action = 'test.about' AND ip_address = '198.51.100.9'`); n != 1 {
		t.Errorf("the administrator's audit event changed: %d", n)
	}
	if n := s.count(`SELECT (SELECT count(*) FROM user_fonts WHERE user_id = $1) + (SELECT count(*) FROM user_sounds WHERE user_id = $1)`, ayseID); n != 0 {
		t.Errorf("fonts and sounds left: %d", n)
	}
	// Both messages are deleted; the held one keeps its text and edit.
	if n := s.count(`SELECT count(*) FROM messages WHERE author_id = $1 AND deleted_at IS NULL`, ayseID); n != 0 {
		t.Errorf("messages still shown: %d", n)
	}
	if n := s.count(`SELECT count(*) FROM message_edits WHERE message_id = $1`, kept.ID); n != 1 {
		t.Errorf("edits of the held message = %d", n)
	}
	if n := s.count(`SELECT count(*) FROM message_edits WHERE message_id = $1`, free.ID); n != 0 {
		t.Errorf("edits of the erased message = %d", n)
	}
	// An open app hears of both.
	gone := map[string]bool{}
	for i := 0; i < 20 && len(gone) < 2; i++ {
		ev := read(t, conn)
		var ref struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal(ev.Data, &ref)
		if ev.Type == "message.deleted" && (ref.ID == free.ID || ref.ID == kept.ID) {
			gone[ref.ID] = true
		}
	}
	if len(gone) != 2 {
		t.Errorf("message.deleted heard for %v", gone)
	}
	for _, m := range s.page(admin, held.ID) {
		if m.ID == kept.ID {
			t.Error("the held message still shows")
		}
	}
	// The bot in General hears of the message there (not of the other channel's).
	s.deliveriesDue()
	if got := receivedWith(rv, free.ID); got != 1 {
		t.Errorf("bot deliveries of the erased message = %d", got)
	}
	if got := receivedWith(rv, kept.ID); got != 0 {
		t.Errorf("bot got a message of a channel it is not in: %d", got)
	}

	// While the hold keeps it, the purge leaves it; once released, it goes.
	q := store.New(s.pool)
	if _, err := q.PurgeDeletedMessages(ctx, pgtype.Interval{Valid: true}); err != nil {
		t.Fatal(err)
	}
	if n := s.count(`SELECT count(*) FROM messages WHERE id = $1`, kept.ID); n != 1 {
		t.Errorf("held message purged: %d", n)
	}
	s.call(http.MethodPost, "/api/legal-holds/"+hold.Id.String()+"/release", admin, nil, &hold)
	if _, err := q.PurgeDeletedMessages(ctx, pgtype.Interval{Valid: true}); err != nil {
		t.Fatal(err)
	}
	if n := s.count(`SELECT count(*) FROM messages WHERE id IN ($1, $2)`, free.ID, kept.ID); n != 0 {
		t.Errorf("messages left after the hold: %d", n)
	}
}

// The servers a channel is shared with take an erased person's messages away;
// a person who came from another server is not sent back there.
func TestErasureReachesSharedChannels(t *testing.T) {
	p := newFedPair(t)
	for i, body := range []string{"bir", "iki"} {
		if _, res := p.a.send(p.author, p.general, body, "fed-erase-000"+string(rune('1'+i))); res.StatusCode != http.StatusCreated {
			t.Fatalf("send = %d", res.StatusCode)
		}
	}
	federate(t, p.a, p.b)
	mirrored := p.b.timeline(p.admin, p.mirror)
	if len(mirrored) != 2 {
		t.Fatalf("mirror = %+v", mirrored)
	}
	var remote string
	if err := p.b.pool.QueryRow(context.Background(), `SELECT author_id::text FROM messages WHERE id = $1`, mirrored[0].Id).Scan(&remote); err != nil {
		t.Fatal(err)
	}

	if res := p.a.call(http.MethodPost, "/api/admin/users/"+p.a.userID(p.author)+"/erase", p.admin, map[string]string{"confirm": "Author"}, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("erase = %d", res.StatusCode)
	}
	if n := p.queued("message.deleted"); n != 2 {
		t.Fatalf("deletions queued = %d", n)
	}
	federate(t, p.a, p.b)
	if got := p.b.timeline(p.admin, p.mirror); len(got) != 0 {
		t.Errorf("mirror after erasure = %+v", got)
	}

	// Erasing the other server's copy of the person on b sends nothing back to a.
	var name string
	_ = p.b.pool.QueryRow(context.Background(), `SELECT display_name FROM users WHERE id = $1`, remote).Scan(&name)
	if res := p.b.call(http.MethodPost, "/api/admin/users/"+remote+"/erase", p.admin, map[string]string{"confirm": name}, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("erase there = %d", res.StatusCode)
	}
	if n := p.b.count(`SELECT count(*) FROM federation_deliveries WHERE connection_id = $1 AND event->>'type' = 'message.deleted'`, p.bConn); n != 0 {
		t.Errorf("deletions sent back to the person's own server: %d", n)
	}
}

// Migrations 00063 and 00062 roll back and apply again.
func TestErasureMigrationDown(t *testing.T) {
	pool := testdb.Open(t)
	var ups, downs []string
	for _, name := range []string{"00062_erasure.sql", "00063_orphan_pictures.sql"} {
		raw, err := migrations.FS.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		up, down, _ := strings.Cut(string(raw), "-- +goose Down")
		ups, downs = append(ups, up), append([]string{down}, downs...)
	}
	for _, sql := range append(downs, ups...) {
		if _, err := pool.Exec(context.Background(), sql); err != nil {
			t.Fatal(err)
		}
	}
}

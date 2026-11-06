// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"context"
	"testing"
	"time"

	"github.com/Cenacle-TR/cenacle/server/internal/chat"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

func TestRecordRetention(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ctx := context.Background()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := s.pool.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	// Records as written then: UUIDv7 ids carry their time.
	oldEvent := func(action string, days int) string {
		t.Helper()
		var id string
		if err := s.pool.QueryRow(ctx,
			`INSERT INTO audit_events (id, at, action) VALUES (uuidv7(-make_interval(days => $2)), now() - make_interval(days => $2), $1)
			 RETURNING id::text`, action, days).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	oldEvent("test.old", 400)
	oldEvent("test.recent", 10)
	exec(`INSERT INTO ai_requests (id, workspace_id, kind, input_chars, created_at)
	      VALUES (uuidv7('-400 days'), $1, 'ask', 1, now() - interval '400 days'),
	             (uuidv7('-10 days'), $1, 'ask', 1, now() - interval '10 days')`, s.defaultWS)
	var picture string
	if err := s.pool.QueryRow(ctx,
		`INSERT INTO pictures (content_type, data) VALUES ('image/png', '\x00') RETURNING id::text`).Scan(&picture); err != nil {
		t.Fatal(err)
	}
	exec(`INSERT INTO link_previews (url, ok, image_id, fetched_at)
	      VALUES ('https://old.example/', true, $1, now() - interval '40 days'),
	             ('https://new.example/', true, NULL, now() - interval '1 day')`, picture)

	q := store.New(s.pool)
	prune := func(p chat.RecordPruner) int {
		t.Helper()
		p.Queries = q
		n, err := p.Run(ctx)
		if err != nil {
			t.Fatal(err)
		}
		return n
	}
	const year, month = 365 * 24 * time.Hour, 30 * 24 * time.Hour

	// No retention (the default): everything stays.
	if n := prune(chat.RecordPruner{}); n != 0 {
		t.Fatalf("pruned without retention = %d", n)
	}
	if n := prune(chat.RecordPruner{Audit: year, AIRequests: year, LinkPreviews: month}); n != 3 {
		t.Fatalf("pruned = %d, want 3", n)
	}
	for query, want := range map[string]int{
		`SELECT count(*) FROM audit_events WHERE action = 'test.old'`:           0,
		`SELECT count(*) FROM audit_events WHERE action = 'test.recent'`:        1,
		`SELECT count(*) FROM ai_requests`:                                      1,
		`SELECT count(*) FROM link_previews WHERE url = 'https://old.example/'`: 0,
		`SELECT count(*) FROM link_previews WHERE url = 'https://new.example/'`: 1,
		`SELECT count(*) FROM pictures WHERE id = '` + picture + `'`:            0,
	} {
		if got := s.count(query); got != want {
			t.Errorf("%s = %d, want %d", query, got, want)
		}
	}

	// A running audit stream keeps what it has not sent yet.
	unsent := oldEvent("test.unsent", 400)
	exec(`UPDATE instance_settings SET audit_stream_kind = 'http', audit_stream_cursor = NULL`)
	if n := prune(chat.RecordPruner{Audit: year}); n != 0 {
		t.Fatalf("pruned unsent events = %d", n)
	}
	exec(`UPDATE instance_settings SET audit_stream_cursor = $1`, unsent)
	if n := prune(chat.RecordPruner{Audit: year}); n != 1 {
		t.Fatalf("pruned sent events = %d, want 1", n)
	}
	exec(`UPDATE instance_settings SET audit_stream_kind = 'none', audit_stream_cursor = NULL`)
}

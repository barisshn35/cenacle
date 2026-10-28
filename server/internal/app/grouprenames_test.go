// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/barisshn35/cenacle/server/internal/groups"
	"github.com/barisshn35/cenacle/server/internal/store"
	"github.com/barisshn35/cenacle/server/internal/testdb"
	"github.com/barisshn35/cenacle/server/migrations"
)

// Migration 00054 rolls back and applies again.
func TestGroupRenamesMigrationDown(t *testing.T) {
	pool := testdb.Open(t)
	raw, err := migrations.FS.ReadFile("00054_group_renames.sql")
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

type groupMapping struct {
	Group      string   `json:"group"`
	Role       string   `json:"role"`
	Candidates []string `json:"candidates"`
}

type channelGroups struct {
	Groups  []string `json:"groups"`
	Managed bool     `json:"managed"`
	Reviews []struct {
		Group      string   `json:"group"`
		Candidates []string `json:"candidates"`
	} `json:"reviews"`
}

// Group mappings follow the names Cenacle ID gives groups when they change
// (ADR 0046): a provider's groups took its name as a prefix in 0.99.2, and
// renaming a provider renames its groups.
func TestGroupMappingsFollowRenames(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ctx := context.Background()
	admin := s.admin()
	eng := s.newWorkspace(admin, "Engineering")
	for group, role := range map[string]string{
		"Design":     "member", // renamed: only Acme has it
		"Ops":        "admin",  // two providers have it: needs review
		"Leads":      "admin",  // its new name is mapped already, as member
		"acme/leads": "member",
	} {
		if res := s.call(http.MethodPut, "/api/workspaces/"+eng+"/groups", admin, map[string]string{"group": group, "role": role}, nil); res.StatusCode != http.StatusOK {
			t.Fatalf("map %q = %d", group, res.StatusCode)
		}
	}
	var builds channel
	s.call(http.MethodPost, "/api/channels", admin, map[string]any{"name": "Builds", "workspace_id": eng, "visibility": "private"}, &builds)
	if res := s.call(http.MethodPut, "/api/channels/"+builds.ID+"/groups", admin, map[string]any{"groups": []string{"Design", "Ops"}, "managed": false}, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("map channel = %d", res.StatusCode)
	}
	// Bob signed in before 0.99.2: Acme's "Design" by its bare name.
	bob := s.signInWith("sub-bob", "Bob", groups.Profile{Groups: []string{"Design"}})
	if !channelNames(s.channels(bob, "/api/channels?workspace_id="+eng))["Builds"] {
		t.Fatal("bob is not in Builds")
	}
	joined := func() (ws, ch time.Time) {
		t.Helper()
		if err := s.pool.QueryRow(ctx, `SELECT
			(SELECT joined_at FROM workspace_members WHERE workspace_id = $1 AND user_id = $3),
			(SELECT joined_at FROM channel_members WHERE channel_id = $2 AND user_id = $3)`,
			eng, builds.ID, s.userID(bob)).Scan(&ws, &ch); err != nil {
			t.Fatal(err)
		}
		return ws, ch
	}
	wsBefore, chBefore := joined()

	renames := []map[string]any{
		{"old": "Design", "new": "Acme/Design"},
		{"old": "Ops", "new": "Acme/Ops", "ambiguous": true},
		{"old": "Ops", "new": "Partner/Ops", "ambiguous": true},
		{"old": "Leads", "new": "Acme/Leads"},
	}
	srv, _ := fakeFeedWith(t, []map[string]any{
		{"sub": "sub-bob", "name": "Bob", "groups": []string{"Acme/Design"}},
	}, renames)
	feed := func(secret string) *groups.Feed {
		return &groups.Feed{
			HTTP: srv.Client(), Issuer: srv.URL, ClientID: "cenacle-chat", ClientSecret: secret,
			DB: s.pool, Queries: store.New(s.pool), AdminEmail: adminEmail,
			Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		}
	}
	mappings := func() map[string]groupMapping {
		t.Helper()
		var list struct{ Mappings []groupMapping }
		s.call(http.MethodGet, "/api/workspaces/"+eng+"/groups", admin, nil, &list)
		out := map[string]groupMapping{}
		for _, m := range list.Mappings {
			out[m.Group] = m
		}
		return out
	}
	audits := func() map[string]int {
		t.Helper()
		rows, err := s.pool.Query(ctx, `SELECT action, count(*) FROM audit_events
			WHERE actor_id IS NULL AND detail->>'by' = 'cenacle_id' GROUP BY action`)
		if err != nil {
			t.Fatal(err)
		}
		out := map[string]int{}
		for rows.Next() {
			var a string
			var n int
			if err := rows.Scan(&a, &n); err != nil {
				t.Fatal(err)
			}
			out[a] = n
		}
		return out
	}

	// Without the feed's credentials nothing is renamed.
	if _, err := feed("wrong").Sync(ctx); err == nil {
		t.Error("sync with a wrong secret succeeded")
	}
	if _, ok := mappings()["Design"]; !ok {
		t.Fatal("a mapping was renamed without the feed")
	}

	if _, err := feed("feed-secret").Sync(ctx); err != nil {
		t.Fatal(err)
	}
	got := mappings()
	if m, ok := got["Acme/Design"]; !ok || m.Role != "member" || len(m.Candidates) != 0 {
		t.Errorf("Design: %+v", got)
	}
	if _, ok := got["Design"]; ok {
		t.Error("the old name is still mapped")
	}
	if m := got["Ops"]; m.Role != "admin" || !slices.Equal(m.Candidates, []string{"Acme/Ops", "Partner/Ops"}) {
		t.Errorf("Ops: %+v", m)
	}
	// The existing mapping of the new name stays; its role is not raised.
	if _, ok := got["Leads"]; ok || got["acme/leads"].Role != "member" || len(got) != 3 {
		t.Errorf("Leads: %+v", got)
	}
	var cg channelGroups
	s.call(http.MethodGet, "/api/channels/"+builds.ID+"/groups", admin, nil, &cg)
	if !slices.Equal(cg.Groups, []string{"Acme/Design", "Ops"}) || len(cg.Reviews) != 1 ||
		cg.Reviews[0].Group != "Ops" || !slices.Equal(cg.Reviews[0].Candidates, []string{"Acme/Ops", "Partner/Ops"}) {
		t.Errorf("channel groups = %+v", cg)
	}
	// Bob kept his memberships throughout: never taken back and given again.
	if ws, ch := joined(); !ws.Equal(wsBefore) || !ch.Equal(chBefore) {
		t.Errorf("bob's memberships were renewed: %v/%v -> %v/%v", wsBefore, chBefore, ws, ch)
	}
	var cursor int64
	if err := s.pool.QueryRow(ctx, "SELECT cursor FROM group_rename_state").Scan(&cursor); err != nil || cursor != 4 {
		t.Errorf("cursor = %d, %v", cursor, err)
	}
	want := map[string]int{
		"workspace.group_mapping_renamed":      1,
		"workspace.group_mapping_merged":       1,
		"workspace.group_mapping_needs_review": 1,
		"channel.group_renamed":                1,
		"channel.group_needs_review":           1,
	}
	if a := audits(); !mapsEqual(a, want) {
		t.Errorf("audit = %v", a)
	}

	// The candidates do not match the mapping under review.
	carol := s.signInWith("sub-carol", "Carol", groups.Profile{Groups: []string{"Partner/Ops"}})
	for _, w := range s.workspaces(carol) {
		if w.ID == eng {
			t.Errorf("a candidate group gave %q", w.Role)
		}
	}

	// Applied once: the next round changes nothing.
	if _, err := feed("feed-secret").Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if a := audits(); !mapsEqual(a, want) {
		t.Errorf("audit after a second round = %v", a)
	}

	// An administrator keeps the mappings under review as they are.
	s.call(http.MethodPut, "/api/workspaces/"+eng+"/groups", admin, map[string]string{"group": "Ops", "role": "admin"}, nil)
	if m := mappings()["Ops"]; len(m.Candidates) != 0 {
		t.Errorf("reviewed mapping = %+v", m)
	}
	// Saving the channel's groups keeps its review until it is done.
	s.call(http.MethodPut, "/api/channels/"+builds.ID+"/groups", admin, map[string]any{"groups": []string{"Acme/Design", "Ops"}, "managed": false}, &cg)
	if len(cg.Reviews) != 1 {
		t.Errorf("review lost on save: %+v", cg)
	}
	s.call(http.MethodPut, "/api/channels/"+builds.ID+"/groups", admin, map[string]any{"groups": []string{"Acme/Design", "Ops"}, "managed": false, "reviewed": []string{"Ops"}}, &cg)
	if len(cg.Reviews) != 0 || !slices.Equal(cg.Groups, []string{"Acme/Design", "Ops"}) {
		t.Errorf("after review: %+v", cg)
	}
}

func mapsEqual(a, b map[string]int) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if b[k] != v {
			return false
		}
	}
	return true
}

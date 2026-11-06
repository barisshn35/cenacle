// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/Cenacle-TR/cenacle/server/internal/chat"
	"github.com/Cenacle-TR/cenacle/server/internal/groups"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
	"github.com/Cenacle-TR/cenacle/server/migrations"
)

// The 00048 migration repairs the rows the old paths left.
func TestGuestRolesRepair(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ctx := context.Background()
	q := store.New(s.pool)
	admin := s.admin()
	ws2 := s.newWorkspace(admin, "Second")
	var general string
	if err := s.pool.QueryRow(ctx, "SELECT id::text FROM channels WHERE workspace_id = $1 AND name = 'General'", ws2).Scan(&general); err != nil {
		t.Fatal(err)
	}
	var link struct{ Token string }
	s.call(http.MethodPost, "/api/channels/"+general+"/guest-links", admin,
		map[string]any{"name": "partner", "expires_in_hours": 24, "password": "guest-pass-1"}, &link)
	_, _, linkGuest := s.joinGuest(link.Token, "Guest", "guest-pass-1")
	dirGuest := s.signInWith("sub-dirguest", "Directory guest", groups.Profile{})
	remote, err := q.UpsertRemoteUser(ctx, store.UpsertRemoteUserParams{AuthData: "conn:person", DisplayName: "Remote"})
	if err != nil {
		t.Fatal(err)
	}
	// What the old start-up sweep, invitations and directory downgrades left.
	for _, sql := range []string{
		"INSERT INTO workspace_members (workspace_id, user_id) SELECT $1, id FROM users WHERE guest_link_id IS NOT NULL OR auth_service = 'remote'",
		`INSERT INTO channel_members (channel_id, user_id) SELECT c.id, wm.user_id FROM channels c
			JOIN workspace_members wm ON wm.workspace_id = c.workspace_id WHERE c.workspace_id = $1 ON CONFLICT DO NOTHING`,
	} {
		if _, err := s.pool.Exec(ctx, sql, s.defaultWS); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.pool.Exec(ctx, "UPDATE users SET directory_role = 'guest' WHERE id = $1", s.userID(dirGuest)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, "UPDATE workspace_members SET role = 'owner' WHERE user_id = $1", s.userID(dirGuest)); err != nil {
		t.Fatal(err)
	}

	raw, err := migrations.FS.ReadFile("00053_guest_roles.sql")
	if err != nil {
		t.Fatal(err)
	}
	up, _, _ := strings.Cut(string(raw), "-- +goose Down")
	if _, err := s.pool.Exec(ctx, up); err != nil {
		t.Fatal(err)
	}
	if role := s.wsRole(s.defaultWS, s.userID(linkGuest)); role != "" {
		t.Errorf("link guest in the default workspace as %q", role)
	}
	if role := s.wsRole(ws2, s.userID(linkGuest)); role != chat.WorkspaceGuest {
		t.Errorf("link guest in its workspace as %q", role)
	}
	if role := s.wsRole(s.defaultWS, uuidText(remote.ID)); role != "" {
		t.Errorf("federated person in the default workspace as %q", role)
	}
	if role := s.wsRole(s.defaultWS, s.userID(dirGuest)); role != chat.WorkspaceGuest {
		t.Errorf("directory guest in the default workspace as %q", role)
	}
	var left int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM channel_members cm JOIN channels c ON c.id = cm.channel_id
		WHERE c.workspace_id = $1 AND cm.user_id = ANY($2::uuid[])`, s.defaultWS,
		[]string{s.userID(linkGuest), uuidText(remote.ID), s.userID(dirGuest)}).Scan(&left); err != nil {
		t.Fatal(err)
	}
	if left != 0 {
		t.Errorf("%d default-workspace channel memberships of guests left", left)
	}
	var stays int
	if err := s.pool.QueryRow(ctx, "SELECT count(*) FROM channel_members WHERE channel_id = $1 AND user_id = $2", general, s.userID(linkGuest)).Scan(&stays); err != nil {
		t.Fatal(err)
	}
	if stays != 1 {
		t.Error("the link guest lost the channel of its link")
	}
}

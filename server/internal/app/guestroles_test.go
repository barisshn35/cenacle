// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"context"
	"net/http"
	"testing"

	guuid "github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/barisshn35/cenacle/server/internal/chat"
	"github.com/barisshn35/cenacle/server/internal/groups"
	"github.com/barisshn35/cenacle/server/internal/store"
)

// wsRole is a person's stored role in a workspace ("" when not a member).
func (s *stack) wsRole(ws, user string) string {
	s.t.Helper()
	var role string
	err := s.pool.QueryRow(context.Background(),
		"SELECT coalesce((SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2), '')", ws, user).Scan(&role)
	if err != nil {
		s.t.Fatal(err)
	}
	return role
}

// A server start does not make link guests, federated people or deactivated
// people members of the default workspace.
func TestEnsureDefaultsLeavesGuestsOut(t *testing.T) {
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
	if res := s.call(http.MethodPost, "/api/channels/"+general+"/guest-links", admin,
		map[string]any{"name": "partner", "expires_in_hours": 24, "password": "guest-pass-1"}, &link); res.StatusCode != http.StatusCreated {
		t.Fatalf("create link = %d", res.StatusCode)
	}
	status, _, guest := s.joinGuest(link.Token, "Guest", "guest-pass-1")
	if status != http.StatusCreated {
		t.Fatalf("join = %d", status)
	}
	remote, err := q.UpsertRemoteUser(ctx, store.UpsertRemoteUserParams{AuthData: "conn:person", DisplayName: "Remote"})
	if err != nil {
		t.Fatal(err)
	}
	gone := s.user("sub-gone", "Gone")
	if _, err := s.pool.Exec(ctx, "DELETE FROM workspace_members WHERE user_id = $1", s.userID(gone)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, "UPDATE users SET deactivated_at = now() WHERE id = $1", s.userID(gone)); err != nil {
		t.Fatal(err)
	}

	if err := chat.EnsureDefaults(ctx, q, chat.Defaults{Announcement: "Central", Channels: []string{"General"}, AdminEmail: adminEmail}); err != nil {
		t.Fatal(err)
	}
	for _, w := range s.workspaces(guest) {
		if w.IsDefault {
			t.Errorf("the link guest is in the default workspace as %s", w.Role)
		}
	}
	var defGeneral string
	if err := s.pool.QueryRow(ctx, "SELECT id::text FROM channels WHERE workspace_id = $1 AND name = 'General'", s.defaultWS).Scan(&defGeneral); err != nil {
		t.Fatal(err)
	}
	if code := s.call(http.MethodPost, "/api/channels/"+defGeneral+"/join", guest, nil, nil).StatusCode; code != http.StatusNotFound {
		t.Errorf("link guest joins the default General = %d", code)
	}
	if role := s.wsRole(s.defaultWS, uuidText(remote.ID)); role != "" {
		t.Errorf("federated person in the default workspace as %q", role)
	}
	if role := s.wsRole(s.defaultWS, s.userID(gone)); role != "" {
		t.Errorf("deactivated person in the default workspace as %q", role)
	}
}

// A directory guest who accepts an invitation joins as a guest, without the
// channels for everyone, and cannot be promoted there.
func TestDirectoryGuestAcceptsInviteAsGuest(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ctx := context.Background()
	admin := s.admin()
	ws2 := s.newWorkspace(admin, "Partner")
	guest := s.signInWith("sub-dirguest", "Guest", groups.Profile{Role: "guest"})
	var got workspace
	if res := s.call(http.MethodPost, "/api/invites/"+s.invite(admin, ws2, map[string]any{})+"/accept", guest, nil, &got); res.StatusCode != http.StatusOK {
		t.Fatalf("accept = %d", res.StatusCode)
	}
	if got.Role != chat.WorkspaceGuest || s.wsRole(ws2, s.userID(guest)) != chat.WorkspaceGuest {
		t.Errorf("role = %s (stored %s), want guest", got.Role, s.wsRole(ws2, s.userID(guest)))
	}
	var channels int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM channel_members cm JOIN channels c ON c.id = cm.channel_id
		WHERE c.workspace_id = $1 AND cm.user_id = $2`, ws2, s.userID(guest)).Scan(&channels); err != nil {
		t.Fatal(err)
	}
	if channels != 0 {
		t.Errorf("the guest joined %d channels for everyone", channels)
	}
	if code := s.call(http.MethodPatch, "/api/workspaces/"+ws2+"/members/"+s.userID(guest), admin,
		map[string]string{"role": "member"}, nil).StatusCode; code != http.StatusForbidden {
		t.Errorf("promote the guest = %d", code)
	}

	// A link guest accepting an invitation is a guest there too.
	var general string
	if err := s.pool.QueryRow(ctx, "SELECT id::text FROM channels WHERE workspace_id = $1 AND name = 'General'", ws2).Scan(&general); err != nil {
		t.Fatal(err)
	}
	var link struct{ Token string }
	s.call(http.MethodPost, "/api/channels/"+general+"/guest-links", admin,
		map[string]any{"name": "partner", "expires_in_hours": 24, "password": "guest-pass-1"}, &link)
	_, _, linkGuest := s.joinGuest(link.Token, "Link guest", "guest-pass-1")
	ws3 := s.newWorkspace(admin, "Third")
	if res := s.call(http.MethodPost, "/api/invites/"+s.invite(admin, ws3, map[string]any{})+"/accept", linkGuest, nil, &got); res.StatusCode != http.StatusOK || got.Role != chat.WorkspaceGuest {
		t.Errorf("link guest accepts = %d as %s", res.StatusCode, got.Role)
	}
}

// An owner whom the directory makes a guest is a guest like everyone else;
// the admins of a workspace left without an owner name the next one.
func TestOwnerBecomesDirectoryGuest(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	owner := s.signInWith("sub-owner", "Owner", groups.Profile{})
	s.call(http.MethodPatch, "/api/workspaces/"+s.defaultWS+"/members/"+s.userID(owner), admin, map[string]string{"role": "owner"}, nil)
	// The owner is the only owner of a second workspace, with an admin.
	ws2 := s.newWorkspace(admin, "Owned")
	deputy := s.user("sub-deputy", "Deputy")
	for _, p := range []string{owner, deputy} {
		s.call(http.MethodPost, "/api/invites/"+s.invite(admin, ws2, map[string]any{})+"/accept", p, nil, nil)
	}
	s.call(http.MethodPatch, "/api/workspaces/"+ws2+"/members/"+s.userID(owner), admin, map[string]string{"role": "owner"}, nil)
	s.call(http.MethodPatch, "/api/workspaces/"+ws2+"/members/"+s.userID(deputy), admin, map[string]string{"role": "admin"}, nil)
	if _, err := s.pool.Exec(context.Background(), "DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", ws2, s.userID(admin)); err != nil {
		t.Fatal(err)
	}

	s.applyProfile("sub-owner", groups.Profile{Role: "guest"})
	for _, ws := range []string{s.defaultWS, ws2} {
		if role := s.wsRole(ws, s.userID(owner)); role != chat.WorkspaceGuest {
			t.Errorf("role in %s = %s, want guest", ws, role)
		}
	}
	if channelNames(s.channels(owner, "/api/channels?workspace_id="+s.defaultWS))["General"] {
		t.Error("the former owner is still in General")
	}
	if code := s.call(http.MethodPost, "/api/channels", owner, map[string]any{"name": "mine"}, nil).StatusCode; code != http.StatusForbidden {
		t.Errorf("former owner creates a channel = %d", code)
	}
	// Ownerless: an admin names an owner (normally only owners do).
	if code := s.call(http.MethodPatch, "/api/workspaces/"+ws2+"/members/"+s.userID(deputy), deputy,
		map[string]string{"role": "owner"}, nil).StatusCode; code != http.StatusOK {
		t.Errorf("admin names the next owner = %d", code)
	}
	other := s.user("sub-other", "Other")
	s.call(http.MethodPost, "/api/invites/"+s.invite(deputy, ws2, map[string]any{})+"/accept", other, nil, nil)
	s.call(http.MethodPatch, "/api/workspaces/"+ws2+"/members/"+s.userID(other), deputy, map[string]string{"role": "admin"}, nil)
	if code := s.call(http.MethodPatch, "/api/workspaces/"+ws2+"/members/"+s.userID(other), other,
		map[string]string{"role": "owner"}, nil).StatusCode; code != http.StatusForbidden {
		t.Errorf("admin grants owner while an owner exists = %d", code)
	}
}

// Changing a channel's groups re-applies the directory only to directory
// accounts: federated people and deactivated members keep what they have.
func TestChannelGroupsSkipNonDirectoryMembers(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ctx := context.Background()
	q := store.New(s.pool)
	admin := s.admin()
	var c channel
	s.call(http.MethodPost, "/api/channels", admin, map[string]any{"name": "Shared"}, &c)
	remote, err := q.UpsertRemoteUser(ctx, store.UpsertRemoteUserParams{AuthData: "conn:person", DisplayName: "Remote"})
	if err != nil {
		t.Fatal(err)
	}
	ws2 := s.newWorkspace(admin, "Second")
	if _, err := q.AddWorkspaceMember(ctx, store.AddWorkspaceMemberParams{WorkspaceID: pgID(t, ws2), UserID: remote.ID, Role: chat.WorkspaceGuest}); err != nil {
		t.Fatal(err)
	}
	var shared channel
	s.call(http.MethodPost, "/api/channels", admin, map[string]any{"name": "Federated", "workspace_id": ws2}, &shared)
	if _, err := q.AddMember(ctx, store.AddMemberParams{ChannelID: pgID(t, shared.ID), UserID: remote.ID, Role: chat.RoleMember}); err != nil {
		t.Fatal(err)
	}
	if res := s.call(http.MethodPut, "/api/channels/"+shared.ID+"/groups", admin, map[string]any{"groups": []string{"team"}, "managed": false}, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("set groups = %d", res.StatusCode)
	}
	if role := s.wsRole(ws2, uuidText(remote.ID)); role != chat.WorkspaceGuest {
		t.Errorf("federated person's role = %q, want guest", role)
	}
	if role := s.wsRole(s.defaultWS, uuidText(remote.ID)); role != "" {
		t.Errorf("federated person joined the default workspace as %q", role)
	}
}

func uuidText(id pgtype.UUID) string { return guuid.UUID(id.Bytes).String() }

func pgID(t *testing.T, id string) pgtype.UUID {
	t.Helper()
	u, err := guuid.Parse(id)
	if err != nil {
		t.Fatal(err)
	}
	return pgtype.UUID{Bytes: u, Valid: true}
}

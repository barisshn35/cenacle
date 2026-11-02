// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/barisshn35/cenacle/server/internal/chat"
	"github.com/barisshn35/cenacle/server/internal/groups"
	"github.com/barisshn35/cenacle/server/internal/store"
)

// A guest's people search does not depend on members the guest may not see:
// hidden matches never take a place within the limit.
func TestGuestSearchUsersLimitAfterVisibility(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	s.admin()
	s.user("sub-aa", "Aa probe hidden")
	guest := s.signInWith("sub-guest", "Zz probe guest", groups.Profile{Role: "guest"})
	var out struct {
		Users []struct {
			DisplayName string `json:"display_name"`
		} `json:"users"`
	}
	if res := s.call(http.MethodGet, "/api/users?q=probe&limit=1", guest, nil, &out); res.StatusCode != http.StatusOK {
		t.Fatalf("search = %d", res.StatusCode)
	}
	if len(out.Users) != 1 || out.Users[0].DisplayName != "Zz probe guest" {
		t.Errorf("q=probe limit=1 = %+v", out.Users)
	}
}

// A guest whom the workspace lets create channels still cannot create a
// channel for everyone (which would show them every member).
func TestGuestCreatesNoChannelForEveryone(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	hidden := s.user("sub-hidden", "Hidden")
	guest := s.signInWith("sub-guest", "Guest", groups.Profile{Role: "guest"})
	ws := "/api/workspaces/" + s.defaultWS
	if res := s.call(http.MethodPut, ws+"/permissions", admin, map[string]any{"permissions": map[string][]string{
		"create_channels": {"admin", "guest"},
	}}, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("set scheme = %d", res.StatusCode)
	}
	if res := s.call(http.MethodPost, "/api/channels", guest, map[string]any{"workspace_id": s.defaultWS, "name": "guest-plain"}, nil); res.StatusCode != http.StatusCreated {
		t.Fatalf("plain channel = %d", res.StatusCode)
	}
	if status, _ := problemCode(t, s, http.MethodPost, "/api/channels", guest,
		map[string]any{"workspace_id": s.defaultWS, "name": "guest-everyone", "is_default": true}); status != http.StatusForbidden {
		t.Errorf("guest's channel for everyone = %d", status)
	}
	var members struct {
		Members []struct {
			User struct {
				ID string `json:"id"`
			} `json:"user"`
		} `json:"members"`
	}
	s.call(http.MethodGet, ws+"/members", guest, nil, &members)
	for _, m := range members.Members {
		if m.User.ID == s.userID(hidden) {
			t.Error("the guest sees a member sharing no channel with them")
		}
	}
}

// Configuring a channel for everyone whose name an existing private, ruled
// channel already has leaves that channel and its members as they are; a
// public channel of a configured name is still taken over.
func TestEnsureDefaultsKeepsPrivateChannel(t *testing.T) {
	sh := newShared(t)
	s := newStack(t, sh, options{})
	r := newRuledScene(s)
	bob := s.user("sub-bob", "Bob")
	var private, open channel
	s.call(http.MethodPost, "/api/channels", r.admin, map[string]any{"name": "hr-private", "visibility": "private"}, &private)
	s.setRules(r.admin, private.ID)
	s.call(http.MethodPost, "/api/channels", r.admin, map[string]any{"name": "lobby"}, &open)

	if err := chat.EnsureDefaults(context.Background(), store.New(sh.pool), chat.Defaults{
		Announcement: "Central", Channels: []string{"General", "HR-Private", "Lobby"}, AdminEmail: adminEmail,
	}); err != nil {
		t.Fatal(err)
	}
	var visibility string
	var isDefault bool
	if err := sh.pool.QueryRow(context.Background(), "SELECT visibility, is_default FROM channels WHERE id = $1", private.ID).Scan(&visibility, &isDefault); err != nil {
		t.Fatal(err)
	}
	if visibility != "private" || isDefault {
		t.Errorf("private channel after EnsureDefaults: visibility=%s default=%v", visibility, isDefault)
	}
	if s.isMember(r.admin, private.ID, s.userID(bob)) {
		t.Error("a member who was never added joined the private channel")
	}
	if !s.isMember(r.admin, open.ID, s.userID(bob)) {
		t.Error("the public channel of a configured name did not become a channel for everyone")
	}
}

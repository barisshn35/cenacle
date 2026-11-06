// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/Cenacle-TR/cenacle/server/internal/chat"
	"github.com/Cenacle-TR/cenacle/server/internal/groups"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
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

// Reactions, edits and the other changes that reach a whole channel have a
// per-user rate limit of their own, like messages.
func TestMemberActionsAreRateLimited(t *testing.T) {
	s := newStack(t, newShared(t), options{perWindow: 2})
	ayse := s.user("sub-a", "Ayşe")
	general := s.general(ayse)
	m, _ := s.send(ayse, general, "hello", "actions-nonce-1")
	reaction := "/api/channels/" + general + "/messages/" + m.ID + "/reactions/%F0%9F%91%8D"
	limit := 5 * 2
	for i := range limit {
		method := http.MethodPut
		if i%2 == 1 {
			method = http.MethodDelete
		}
		if res := s.call(method, reaction, ayse, nil, nil); res.StatusCode >= 300 {
			t.Fatalf("toggle %d = %d", i, res.StatusCode)
		}
	}
	res := s.call(http.MethodPatch, "/api/channels/"+general+"/messages/"+m.ID, ayse, map[string]string{"body": "edited"}, nil)
	if res.StatusCode != http.StatusTooManyRequests || res.Header.Get("Retry-After") == "" {
		t.Errorf("edit past the limit = %d, Retry-After %q", res.StatusCode, res.Header.Get("Retry-After"))
	}
	if res := s.call(http.MethodPut, "/api/me/status", ayse, map[string]any{"emoji": "🌴"}, nil); res.StatusCode != http.StatusTooManyRequests {
		t.Errorf("status past the limit = %d", res.StatusCode)
	}
	// Another member's limit is their own.
	mert := s.user("sub-m", "Mert")
	if res := s.call(http.MethodPut, reaction, mert, nil, nil); res.StatusCode >= 300 {
		t.Errorf("another member's reaction = %d", res.StatusCode)
	}
}

// A workspace admin who is not an owner does not read in the audit log what
// only owners (legal holds, eDiscovery) and spillage reviewers see.
func TestWorkspaceAuditHidesOwnerOnlyEvents(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	owner := s.admin()
	deputy := s.user("sub-d", "Deputy")
	mert := s.user("sub-m", "Mert")
	zeynep := s.user("sub-z", "Zeynep")
	ws := "/api/workspaces/" + s.defaultWS
	if res := s.call(http.MethodPatch, ws+"/members/"+s.userID(deputy), owner, map[string]string{"role": "admin"}, nil); res.StatusCode >= 300 {
		t.Fatalf("promote = %d", res.StatusCode)
	}
	if res := s.call(http.MethodPost, ws+"/legal-holds", owner, map[string]any{"name": "secret-hold", "user_ids": []string{s.userID(mert)}, "channel_ids": []string{}}, nil); res.StatusCode != http.StatusCreated {
		t.Fatalf("hold = %d", res.StatusCode)
	}
	s.call(http.MethodGet, ws+"/export?q=secret-query", owner, nil, nil)
	dm, _ := s.open(mert, s.defaultWS, s.userID(zeynep))
	m, _ := s.send(mert, dm.ID, "oops", "audit-hide-1")
	if res := s.call(http.MethodPost, "/api/channels/"+dm.ID+"/messages/"+m.ID+"/spillage", mert, map[string]string{"reason": "secret"}, nil); res.StatusCode != http.StatusCreated {
		t.Fatalf("report = %d", res.StatusCode)
	}
	actions := func(token string) map[string]bool {
		var page struct {
			Events []auditEvent `json:"events"`
		}
		if res := s.call(http.MethodGet, ws+"/audit?limit=100", token, nil, &page); res.StatusCode != http.StatusOK {
			t.Fatalf("audit = %d", res.StatusCode)
		}
		out := map[string]bool{}
		for _, e := range page.Events {
			out[e.Action] = true
		}
		return out
	}
	hidden := []string{"legal_hold.changed", "messages.exported", "spillage.reported"}
	seen := actions(deputy)
	for _, a := range hidden {
		if seen[a] {
			t.Errorf("a non-owner admin reads %s", a)
		}
	}
	if !seen["workspace.role_changed"] {
		t.Errorf("deputy's audit = %v", seen)
	}
	seen = actions(owner)
	for _, a := range hidden {
		if !seen[a] {
			t.Errorf("the owner does not read %s", a)
		}
	}
}

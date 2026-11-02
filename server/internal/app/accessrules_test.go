// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"net/http"
	"testing"

	"github.com/barisshn35/cenacle/server/internal/groups"
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

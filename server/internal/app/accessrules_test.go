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

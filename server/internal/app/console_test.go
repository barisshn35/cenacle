// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"fmt"
	"net/http"
	"net/url"
	"testing"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/config"
)

func TestSystemConsole(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	for i := range 51 {
		s.user(fmt.Sprintf("sub-p%02d", i), fmt.Sprintf("Kişi %02d", i))
	}

	if status, _ := problemCode(t, s, http.MethodGet, "/api/admin/overview", ayse, nil); status != http.StatusForbidden {
		t.Errorf("member sees the console = %d", status)
	}
	var overview api.AdminOverview
	if res := s.call(http.MethodGet, "/api/admin/overview", admin, nil, &overview); res.StatusCode != http.StatusOK {
		t.Fatalf("overview = %d", res.StatusCode)
	}
	if overview.Counts.Users < 53 || overview.Counts.Workspaces < 1 {
		t.Errorf("overview = %+v", overview.Counts)
	}
	for _, c := range overview.Config {
		if c.Name == "oidc_client_secret" && c.Value != "set" && c.Value != "" {
			t.Errorf("a secret shows: %s", c.Value)
		}
	}

	// People, 50 at a time, and found by name.
	var page struct {
		Users []api.AdminUser `json:"users"`
		Next  *struct {
			AfterName string `json:"after_name"`
			AfterID   string `json:"after_id"`
		} `json:"next"`
	}
	s.call(http.MethodGet, "/api/admin/users", admin, nil, &page)
	if len(page.Users) != 50 || page.Next == nil {
		t.Fatalf("first page = %d %v", len(page.Users), page.Next)
	}
	var rest struct{ Users []api.AdminUser }
	s.call(http.MethodGet, "/api/admin/users?after_name="+url.QueryEscape(page.Next.AfterName)+"&after_id="+page.Next.AfterID, admin, nil, &rest)
	if len(rest.Users) != 3 {
		t.Errorf("second page = %d", len(rest.Users))
	}
	var found struct{ Users []api.AdminUser }
	s.call(http.MethodGet, "/api/admin/users?q=ay%C5%9Fe", admin, nil, &found)
	if len(found.Users) != 1 || found.Users[0].Sessions < 1 {
		t.Fatalf("search = %+v", found.Users)
	}

	// Signing someone out everywhere.
	if res := s.call(http.MethodDelete, "/api/admin/users/"+found.Users[0].Id.String()+"/sessions", admin, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("end sessions = %d", res.StatusCode)
	}
	if res := s.call(http.MethodGet, "/api/channels", ayse, nil, nil); res.StatusCode != http.StatusUnauthorized {
		t.Errorf("signed-out session = %d", res.StatusCode)
	}

	// Workspaces and bots of the whole installation; a bot turned off.
	var wss struct{ Workspaces []api.AdminWorkspace }
	s.call(http.MethodGet, "/api/admin/workspaces", admin, nil, &wss)
	if len(wss.Workspaces) == 0 || !wss.Workspaces[0].IsDefault || wss.Workspaces[0].Members < 53 {
		t.Errorf("workspaces = %+v", wss.Workspaces)
	}
	b := s.newBot(admin, "Yedek")
	var bots struct{ Bots []api.AdminBot }
	s.call(http.MethodGet, "/api/admin/bots", admin, nil, &bots)
	if len(bots.Bots) != 1 || bots.Bots[0].Name != "Yedek" {
		t.Fatalf("bots = %+v", bots.Bots)
	}
	if res := s.call(http.MethodPatch, "/api/admin/bots/"+b.ID, admin, map[string]bool{"disabled": true}, nil); res.StatusCode != http.StatusNoContent {
		t.Errorf("disable bot = %d", res.StatusCode)
	}
	s.call(http.MethodGet, "/api/admin/bots", admin, nil, &bots)
	if !bots.Bots[0].Disabled {
		t.Error("bot still on")
	}

	// The notification policy, and the apps learn it from /api/meta.
	var pol api.NotificationPolicy
	s.call(http.MethodGet, "/api/admin/notification-policy", admin, nil, &pol)
	if pol.PushContents != api.NotificationPolicyPushContentsFull {
		t.Errorf("default policy = %+v", pol)
	}
	if res := s.call(http.MethodPut, "/api/admin/notification-policy", admin, map[string]string{"push_contents": "none", "email_contents": "sender"}, &pol); res.StatusCode != http.StatusOK {
		t.Fatalf("set policy = %d", res.StatusCode)
	}
	if status, _ := problemCode(t, s, http.MethodPut, "/api/admin/notification-policy", admin, map[string]string{"push_contents": "all", "email_contents": "sender"}); status != http.StatusBadRequest {
		t.Errorf("bad policy = %d", status)
	}
	var meta api.Meta
	s.call(http.MethodGet, "/api/meta", "", nil, &meta)
	if meta.PushContents == nil || *meta.PushContents != api.MetaPushContentsNone {
		t.Errorf("meta = %+v", meta)
	}
	// Everyone can find the source code of the server they use (AGPL-3.0 section 13).
	if meta.SourceUrl == nil || *meta.SourceUrl != config.DefaultSourceURL {
		t.Errorf("source_url = %v", meta.SourceUrl)
	}
}

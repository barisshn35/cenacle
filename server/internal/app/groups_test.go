// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/barisshn35/cenacle/server/internal/groups"
	"github.com/barisshn35/cenacle/server/internal/store"
)

// signInWith applies what Cenacle ID says about a person at sign-in (the OIDC
// flow itself is tested in package auth) and returns a session token.
func (s *stack) signInWith(subject, name string, p groups.Profile) string {
	s.t.Helper()
	token := s.user(subject, name)
	s.applyProfile(subject, p)
	return token
}

func (s *stack) applyProfile(subject string, p groups.Profile) {
	s.t.Helper()
	q := store.New(s.pool)
	u, err := q.GetUserByAuth(context.Background(), store.GetUserByAuthParams{AuthService: "cenacle-id", AuthData: subject})
	if err != nil {
		s.t.Fatal(err)
	}
	if err := groups.Apply(context.Background(), q, u, p, adminEmail); err != nil {
		s.t.Fatal(err)
	}
}

func channelNames(cs []channel) map[string]bool {
	out := map[string]bool{}
	for _, c := range cs {
		out[c.Name] = true
	}
	return out
}

func TestGroupMappings(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	eng := s.newWorkspace(admin, "Engineering")
	// Map the directory group "engineering" to the workspace, then a channel.
	if res := s.call(http.MethodPut, "/api/workspaces/"+eng+"/groups", admin, map[string]string{"group": "engineering", "role": "member"}, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("map workspace = %d", res.StatusCode)
	}
	var builds channel
	s.call(http.MethodPost, "/api/channels", admin, map[string]any{"name": "Builds", "workspace_id": eng, "visibility": "private"}, &builds)
	if res := s.call(http.MethodPut, "/api/channels/"+builds.ID+"/groups", admin, map[string]any{"groups": []string{"engineering"}, "managed": true}, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("map channel = %d", res.StatusCode)
	}

	// Bob is in engineering: at sign-in he joins the workspace and the channel.
	bob := s.signInWith("sub-bob", "Bob", groups.Profile{Username: "bob", Groups: []string{"engineering", "staff"}})
	if ws := s.workspaces(bob); len(ws) != 2 {
		t.Fatalf("bob's workspaces = %+v", ws)
	}
	if !channelNames(s.channels(bob, "/api/channels?workspace_id="+eng))["Builds"] {
		t.Error("bob is not in Builds")
	}
	// Managed by groups: nobody leaves or is added by hand.
	if status, code := problemCode(t, s, http.MethodPost, "/api/channels/"+builds.ID+"/leave", bob, nil); status != http.StatusForbidden || code != "group_managed" {
		t.Errorf("leave managed channel = %d %s", status, code)
	}
	carol := s.signInWith("sub-carol", "Carol", groups.Profile{Groups: []string{"design"}})
	if status, code := problemCode(t, s, http.MethodPost, "/api/channels/"+builds.ID+"/members", admin, map[string]string{"user_id": s.userID(carol)}); status != http.StatusForbidden || code != "group_managed" {
		t.Errorf("add to managed channel = %d %s", status, code)
	}
	if ws := s.workspaces(carol); len(ws) != 1 {
		t.Errorf("carol (design) got workspaces %+v", ws)
	}

	// Bob leaves the group in the directory: next sign-in takes it all back.
	s.applyProfile("sub-bob", groups.Profile{Username: "bob", Groups: []string{"staff"}})
	if ws := s.workspaces(bob); len(ws) != 1 {
		t.Errorf("after leaving the group: %+v", ws)
	}

	// Mapping changes apply at once to the people of the group.
	s.call(http.MethodPut, "/api/workspaces/"+eng+"/groups", admin, map[string]string{"group": "design", "role": "admin"}, nil)
	if ws := s.workspaces(carol); len(ws) != 2 || ws[1].Role != "admin" {
		t.Errorf("carol after design mapping = %+v", ws)
	}
	var list struct {
		Mappings []struct {
			Group string `json:"group"`
			Role  string `json:"role"`
		} `json:"mappings"`
		Groups []string `json:"groups"`
	}
	s.call(http.MethodGet, "/api/workspaces/"+eng+"/groups", admin, nil, &list)
	if len(list.Mappings) != 2 || len(list.Groups) < 2 {
		t.Errorf("mappings = %+v", list)
	}
	if status, _ := problemCode(t, s, http.MethodGet, "/api/workspaces/"+eng+"/groups", carol, nil); status != http.StatusOK {
		// Carol is an admin of the workspace now.
		t.Errorf("admin listing = %d", status)
	}
	if res := s.call(http.MethodDelete, "/api/workspaces/"+eng+"/groups/design", admin, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Errorf("delete mapping = %d", res.StatusCode)
	}
	if ws := s.workspaces(carol); len(ws) != 1 {
		t.Errorf("carol after the mapping is gone = %+v", ws)
	}
}

func TestDirectoryRoles(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	general := s.general(admin)

	// The directory's admin filter makes an instance administrator.
	boss := s.signInWith("sub-boss", "Boss", groups.Profile{Role: "admin"})
	var session struct {
		Permissions struct {
			CreateWorkspaces bool `json:"create_workspaces"`
		} `json:"permissions"`
	}
	s.call(http.MethodGet, "/api/session", boss, nil, &session)
	if !session.Permissions.CreateWorkspaces {
		t.Error("directory admin cannot create workspaces")
	}
	// Several administrators: the configured one keeps it too.
	s.call(http.MethodGet, "/api/session", admin, nil, &session)
	if !session.Permissions.CreateWorkspaces {
		t.Error("the configured administrator lost it")
	}

	// A guest sees only the channels they are in, and the people in them.
	// (The test helper made them a member of the default workspace first:
	// becoming a guest makes them a guest there too.)
	guest := s.signInWith("sub-guest", "Guest", groups.Profile{Role: "guest"})
	for _, w := range s.workspaces(guest) {
		if w.Role != "guest" {
			t.Fatalf("guest has role %q in %s", w.Role, w.Name)
		}
	}
	if cs := s.channels(guest, "/api/channels"); len(cs) != 0 {
		t.Errorf("guest kept channels %+v", cs)
	}
	ops := s.newWorkspace(admin, "Ops")
	s.call(http.MethodPut, "/api/workspaces/"+ops+"/groups", admin, map[string]string{"group": "contractors", "role": "member"}, nil)
	s.applyProfile("sub-guest", groups.Profile{Role: "guest", Groups: []string{"contractors"}})
	ws := s.workspaces(guest)
	if len(ws) != 2 || ws[1].Role != "guest" {
		t.Fatalf("guest workspaces = %+v", ws)
	}
	var open, project channel
	s.call(http.MethodPost, "/api/channels", admin, map[string]any{"name": "Open", "workspace_id": ops}, &open)
	s.call(http.MethodPost, "/api/channels", admin, map[string]any{"name": "Project", "workspace_id": ops, "visibility": "private"}, &project)
	s.call(http.MethodPost, "/api/channels/"+project.ID+"/members", admin, map[string]string{"user_id": s.userID(guest)}, nil)
	dir := channelNames(s.channels(guest, "/api/channels/directory?workspace_id="+ops))
	if dir["Open"] || !dir["Project"] {
		t.Errorf("guest directory = %v", dir)
	}
	if status, _ := problemCode(t, s, http.MethodPost, "/api/channels/"+open.ID+"/join", guest, nil); status != http.StatusNotFound {
		t.Errorf("guest joining a public channel = %d", status)
	}
	if status, _ := problemCode(t, s, http.MethodGet, "/api/channels/"+open.ID+"/messages", guest, nil); status != http.StatusNotFound {
		t.Errorf("guest reading a public channel = %d", status)
	}
	// People: only those in the guest's channels.
	other := s.user("sub-other", "Other")
	s.call(http.MethodPut, "/api/workspaces/"+ops+"/groups", admin, map[string]string{"group": "ops", "role": "member"}, nil)
	s.applyProfile("sub-other", groups.Profile{Groups: []string{"ops"}})
	var members struct {
		Members []member `json:"members"`
	}
	s.call(http.MethodGet, "/api/workspaces/"+ops+"/members", guest, nil, &members)
	for _, m := range members.Members {
		if m.User.DisplayName == "Other" {
			t.Error("guest sees someone outside their channels")
		}
	}
	if status, _ := problemCode(t, s, http.MethodPost, "/api/workspaces/"+ops+"/conversations", guest, map[string]any{"user_ids": []string{s.userID(other)}}); status != http.StatusBadRequest {
		t.Errorf("guest messaging someone outside their channels = %d", status)
	}
	_ = general
}

// fakeFeed is Cenacle ID's directory feed with a page of changes.
func fakeFeed(t *testing.T, users []map[string]any) (*httptest.Server, *int) {
	var mu sync.Mutex
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, secret, ok := r.BasicAuth()
		if !ok || id != "cenacle-chat" || secret != "feed-secret" ||
			(r.URL.Path != "/directory/v1/changes" && !strings.HasPrefix(r.URL.Path, "/directory/v1/photos/")) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		mu.Lock()
		calls++
		mu.Unlock()
		if strings.HasPrefix(r.URL.Path, "/directory/v1/photos/") {
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(pngImage(t, 300, 300))
			return
		}
		page := map[string]any{"users": users, "next": "c1", "more": false}
		if r.URL.Query().Get("after") == "c1" {
			page = map[string]any{"users": []any{}, "next": "c1", "more": false}
		}
		_ = json.NewEncoder(w).Encode(page)
	}))
	t.Cleanup(srv.Close)
	return srv, &calls
}

func TestDirectoryFeed(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	eng := s.newWorkspace(admin, "Engineering")
	s.call(http.MethodPut, "/api/workspaces/"+eng+"/groups", admin, map[string]string{"group": "engineering", "role": "member"}, nil)
	bob := s.user("sub-bob", "Bob")
	gone := s.user("sub-gone", "Gone")
	srv, _ := fakeFeed(t, []map[string]any{
		{"sub": "sub-bob", "name": "Bob Builder", "email": "bob@example.com", "email_verified": true,
			"preferred_username": "bob", "groups": []string{"engineering"}, "cenacle_role": "", "disabled": false,
			"picture": "0f1e2d"},
		{"sub": "sub-gone", "name": "Gone", "disabled": true},
		{"sub": "sub-never-signed-in", "name": "Nobody", "disabled": false},
	})
	feed := &groups.Feed{
		HTTP: srv.Client(), Issuer: srv.URL, ClientID: "cenacle-chat", ClientSecret: "feed-secret",
		DB: s.pool, Queries: store.New(s.pool), AdminEmail: adminEmail,
		Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	n, err := feed.Sync(context.Background())
	if err != nil || n != 2 {
		t.Fatalf("sync = %d, %v", n, err)
	}
	// Bob: new name, the group's workspace.
	var session struct {
		User struct {
			DisplayName string `json:"display_name"`
		} `json:"user"`
	}
	s.call(http.MethodGet, "/api/session", bob, nil, &session)
	if session.User.DisplayName != "Bob Builder" || len(s.workspaces(bob)) != 2 {
		t.Errorf("bob = %+v, %d workspaces", session.User, len(s.workspaces(bob)))
	}
	// The directory's photo is Bob's picture.
	if me := s.me(bob); me.AvatarUrl == nil || me.Username != "bob" {
		t.Errorf("bob's profile = %+v", me)
	}
	// Gone: deactivated, signed out everywhere.
	if res := s.call(http.MethodGet, "/api/session", gone, nil, nil); res.StatusCode != http.StatusUnauthorized {
		t.Errorf("deactivated session = %d", res.StatusCode)
	}
	// Nothing new on the next round.
	if n, err := feed.Sync(context.Background()); err != nil || n != 0 {
		t.Errorf("second sync = %d, %v", n, err)
	}
}

// Cenacle ID names an identity provider's groups "<provider>/<name>" (ADR
// 0045): a provider's group never meets a mapping of a directory group.
func TestGroupsOfProvidersStayApart(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	eng := s.newWorkspace(admin, "Engineering")
	for group, role := range map[string]string{"Engineering Leads": "admin", "Partner/Engineering Leads": "member"} {
		if res := s.call(http.MethodPut, "/api/workspaces/"+eng+"/groups", admin, map[string]string{"group": group, "role": role}, nil); res.StatusCode != http.StatusOK {
			t.Fatalf("map %q = %d", group, res.StatusCode)
		}
	}
	role := func(token string) string {
		for _, w := range s.workspaces(token) {
			if w.ID == eng {
				return w.Role
			}
		}
		return ""
	}
	partner := s.signInWith("sub-partner", "Eve", groups.Profile{Groups: []string{"Partner/Engineering Leads"}})
	if r := role(partner); r != "member" {
		t.Errorf("the provider's group gave %q, want member", r)
	}
	if status, _ := problemCode(t, s, http.MethodGet, "/api/workspaces/"+eng+"/groups", partner, nil); status != http.StatusForbidden {
		t.Errorf("provider member reads the workspace's groups: %d", status)
	}
	lead := s.signInWith("sub-lead", "Ada", groups.Profile{Groups: []string{"engineering leads"}})
	if r := role(lead); r != "admin" {
		t.Errorf("the directory's group gave %q, want admin", r)
	}
}

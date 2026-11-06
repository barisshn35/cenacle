// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"testing"

	"github.com/Cenacle-TR/cenacle/server/internal/groups"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

// The entries of the directory feed are independent: one that cannot be
// stored does not hold up the ones after it (a deactivation above all), and
// a @username the directory gave someone else before goes to its new holder.
func TestDirectoryFeedEntriesAreIndependent(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	s.admin()
	x := s.signInWith("sub-x", "Xavier", groups.Profile{Username: "xavier"})
	y := s.signInWith("sub-y", "Yusuf", groups.Profile{Username: "bob"})
	s.signInWith("sub-bad", "Bad", groups.Profile{})
	gone := s.user("sub-gone", "Gone")
	if me := s.me(y); me.Username != "bob" {
		t.Fatalf("y's username = %q", me.Username)
	}
	// The directory gave @bob to x and @robert to y; x's change comes first.
	srv, _ := fakeFeed(t, []map[string]any{
		{"sub": "sub-bad", "name": "Bad\u0000Name", "disabled": false},
		{"sub": "sub-x", "name": "Xavier", "preferred_username": "bob", "disabled": false},
		{"sub": "sub-y", "name": "Yusuf", "preferred_username": "robert", "disabled": false},
		{"sub": "sub-gone", "name": "Gone", "disabled": true},
	})
	feed := &groups.Feed{
		HTTP: srv.Client(), Issuer: srv.URL, ClientID: "cenacle-chat", ClientSecret: "feed-secret",
		DB: s.pool, Queries: store.New(s.pool), AdminEmail: adminEmail,
		Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	if n, err := feed.Sync(context.Background()); err != nil || n != 3 {
		t.Fatalf("sync = %d, %v", n, err)
	}
	if res := s.call(http.MethodGet, "/api/session", gone, nil, nil); res.StatusCode != http.StatusUnauthorized {
		t.Errorf("deactivated person's session = %d", res.StatusCode)
	}
	if me := s.me(x); me.Username != "bob" {
		t.Errorf("x's username = %q, want bob", me.Username)
	}
	if me := s.me(y); me.Username != "robert" {
		t.Errorf("y's username = %q, want robert", me.Username)
	}
}

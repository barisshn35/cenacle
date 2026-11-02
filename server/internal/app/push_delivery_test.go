// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/notify"
	"github.com/barisshn35/cenacle/server/internal/store"
)

// pushOn turns web push on for a person (with a default level) and
// subscribes the endpoints from their session.
func (s *stack) pushOn(token, level string, endpoints ...string) {
	s.t.Helper()
	var set api.NotificationSettings
	s.call(http.MethodGet, "/api/me/notifications", token, nil, &set)
	set.Prefs.Push = true
	if level != "" {
		set.Prefs.DefaultLevel = api.NotificationPrefsDefaultLevel(level)
	}
	if res := s.call(http.MethodPut, "/api/me/notifications", token, set.Prefs, nil); res.StatusCode != http.StatusOK {
		s.t.Fatalf("push on = %d", res.StatusCode)
	}
	for _, e := range endpoints {
		if res := s.call(http.MethodPost, "/api/me/push-subscriptions", token, map[string]any{"endpoint": e, "keys": map[string]string{"p256dh": "k", "auth": "a"}}, nil); res.StatusCode != http.StatusNoContent {
			s.t.Fatalf("subscribe %s = %d", e, res.StatusCode)
		}
	}
}

// pushCrowd adds n people to the default channels, each told about every
// message by web push on one subscription of a live session.
func (s *stack) pushCrowd(n int) {
	s.t.Helper()
	ctx := context.Background()
	for _, q := range []string{
		`INSERT INTO users (auth_service, auth_data, email, email_verified, display_name)
		 SELECT 'cenacle-id', 'crowd-' || g, 'crowd-' || g || '@example.com', true, 'Crowd ' || g FROM generate_series(1, $1::int) g`,
		`INSERT INTO workspace_members (workspace_id, user_id)
		 SELECT w.id, u.id FROM workspaces w, users u WHERE w.is_default AND u.auth_data LIKE 'crowd-%'`,
		`INSERT INTO channel_members (channel_id, user_id)
		 SELECT c.id, u.id FROM channels c JOIN workspaces w ON w.id = c.workspace_id AND w.is_default, users u
		 WHERE c.is_default AND u.auth_data LIKE 'crowd-%'`,
		`INSERT INTO notification_prefs (user_id, prefs)
		 SELECT id, '{"push": true, "default_level": "all"}' FROM users WHERE auth_data LIKE 'crowd-%'`,
		`INSERT INTO sessions (user_id, token_hash, expires_at, user_agent, ip_address, idp_sid)
		 SELECT id, sha256(convert_to(auth_data, 'UTF8')), now() + interval '1 day', '', '127.0.0.1', '' FROM users WHERE auth_data LIKE 'crowd-%'`,
		`INSERT INTO push_subscriptions (user_id, session_id, endpoint, p256dh, auth)
		 SELECT u.id, se.id, 'https://push.example/' || u.auth_data, 'k', 'a' FROM users u JOIN sessions se ON se.user_id = u.id
		 WHERE u.auth_data LIKE 'crowd-%'`,
	} {
		var err error
		if strings.Contains(q, "$1") {
			_, err = s.pool.Exec(ctx, q, n)
		} else {
			_, err = s.pool.Exec(ctx, q)
		}
		if err != nil {
			s.t.Fatal(err)
		}
	}
}

func (s *stack) pusher(sender notify.Sender, online ...string) *notify.Pusher {
	presence := fakePresence{}
	for _, token := range online {
		presence[s.userID(token)] = "online"
	}
	return &notify.Pusher{Queries: store.New(s.pool), Push: sender, Presence: presence, Sessions: s.sessions,
		PublicURL: "http://chat.test", Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
}

func distinctCalls(f *fakeSender, prefix string) map[string]int {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[string]int{}
	for _, c := range f.calls {
		if strings.HasPrefix(c, prefix) {
			out[c]++
		}
	}
	return out
}

// A session the session policy has ended gets no more pushes, and the
// clean-up removes it with its subscription.
func TestPushStopsWithSessionPolicy(t *testing.T) {
	s := newStack(t, newShared(t), options{pushKey: "BPUBLICKEY"})
	admin := s.admin()
	mert := s.user("sub-m", "Mert")
	general := s.general(admin)
	s.pushOn(mert, "", "https://push.example/mert")
	ctx := context.Background()
	sender := &fakeSender{}
	p := s.pusher(sender, admin)
	if _, err := p.Run(ctx); err != nil {
		t.Fatal(err)
	}
	policy := api.SessionPolicy{SessionMaxHours: 1, AdminNetworks: []string{"127.0.0.1"}, SigninNetworks: []string{}}
	if res := s.call(http.MethodPut, "/api/admin/session-policy", admin, policy, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("policy = %d", res.StatusCode)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE sessions SET created_at = now() - interval '2 hours' WHERE user_id = $1`, s.userID(mert)); err != nil {
		t.Fatal(err)
	}
	if res := s.call(http.MethodGet, "/api/channels", mert, nil, nil); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("ended session = %d", res.StatusCode)
	}
	s.send(admin, general, "hello <@"+s.userID(mert)+">", "n-policy-1")
	if _, err := p.Run(ctx); err != nil {
		t.Fatal(err)
	}
	if len(sender.calls) != 0 {
		t.Errorf("pushed to a session the policy ended: %v", sender.calls)
	}
	if _, err := s.sessions.DeleteExpired(ctx); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := s.pool.QueryRow(ctx, "SELECT count(*) FROM push_subscriptions").Scan(&n); err != nil || n != 0 {
		t.Errorf("subscriptions left = %d %v", n, err)
	}
}

// pushWorkersInTest is how many pushes the Pusher sends side by side.
const pushWorkersInTest = 16

// stallingSender never answers for some endpoints (until the push's time is
// up); the others it records.
type stallingSender struct {
	fakeSender
	stall string
}

func (f *stallingSender) Send(ctx context.Context, endpoint, p256dh, auth string, p notify.Payload) error {
	if strings.HasPrefix(endpoint, f.stall) {
		f.mu.Lock()
		f.calls = append(f.calls, endpoint)
		f.mu.Unlock()
		<-ctx.Done()
		return ctx.Err()
	}
	return f.fakeSender.Send(ctx, endpoint, p256dh, auth, p)
}

// One person's push endpoints that never answer delay nobody else's pushes,
// and rest after failing instead of being tried on every run.
func TestPushStalledEndpointsHoldBackOnlyTheirOwner(t *testing.T) {
	s := newStack(t, newShared(t), options{pushKey: "BPUBLICKEY"})
	admin := s.admin()
	mallory := s.user("sub-y", "Mallory")
	mert := s.user("sub-m", "Mert")
	general := s.general(admin)
	var slow []string
	for i := range 20 {
		slow = append(slow, fmt.Sprintf("https://slow.example/%02d", i))
	}
	s.pushOn(mallory, "all", slow...)
	s.pushOn(mert, "", "https://push.example/mert")
	ctx := context.Background()
	sender := &stallingSender{stall: "https://slow.example/"}
	p := s.pusher(sender, admin)
	if _, err := p.Run(ctx); err != nil {
		t.Fatal(err)
	}
	for i := range 4 {
		s.send(admin, general, fmt.Sprintf("news %d", i), fmt.Sprintf("n-stall-%d", i))
	}
	s.send(admin, general, "hello <@"+s.userID(mert)+">", "n-stall-mert")

	runCtx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	began := time.Now()
	if _, err := p.Run(runCtx); err != nil {
		t.Fatal(err)
	}
	if took := time.Since(began); took > 20*time.Second {
		t.Errorf("run took %v", took)
	}
	if got := distinctCalls(&sender.fakeSender, "https://push.example/mert"); got["https://push.example/mert"] != 1 {
		t.Errorf("mert's pushes = %v", got)
	}
	// Each slow endpoint was waited for once at most; those that failed rest,
	// and the next run does not wait for them again.
	tried := distinctCalls(&sender.fakeSender, "https://slow.example/")
	for e, n := range tried {
		if n != 1 {
			t.Errorf("%s tried %d times", e, n)
		}
	}
	var resting int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM push_subscriptions WHERE failures = 1 AND retry_at > now()`).Scan(&resting); err != nil || resting != len(tried) || resting < pushWorkersInTest {
		t.Errorf("resting = %d of %d tried, %v", resting, len(tried), err)
	}
	s.send(admin, general, "more news", "n-stall-more")
	if _, err := p.Run(runCtx); err != nil {
		t.Fatal(err)
	}
	for e, n := range distinctCalls(&sender.fakeSender, "https://slow.example/") {
		if tried[e] > 0 && n != tried[e] {
			t.Errorf("resting %s tried again", e)
		}
	}
}

// Every person of a message with more people than one page is told.
func TestPushMessageBeyondOnePage(t *testing.T) {
	s := newStack(t, newShared(t), options{pushKey: "BPUBLICKEY"})
	admin := s.admin()
	general := s.general(admin)
	s.pushCrowd(2001)
	sender := &fakeSender{}
	p := s.pusher(sender, admin)
	ctx := context.Background()
	if _, err := p.Run(ctx); err != nil {
		t.Fatal(err)
	}
	s.send(admin, general, "everyone", "n-crowd-1")
	for range 3 {
		if _, err := p.Run(ctx); err != nil {
			t.Fatal(err)
		}
	}
	got := distinctCalls(sender, "https://push.example/crowd-")
	if len(got) != 2001 {
		t.Errorf("told %d of 2001", len(got))
	}
	for e, n := range got {
		if n != 1 {
			t.Errorf("%s told %d times", e, n)
		}
	}
}

// A run goes on past one page: a busy large channel does not hold back a
// later message to someone else until the next runs.
func TestPushDrainsPagesInOneRun(t *testing.T) {
	s := newStack(t, newShared(t), options{pushKey: "BPUBLICKEY"})
	admin := s.admin()
	mert := s.user("sub-m", "Mert")
	general := s.general(admin)
	s.pushOn(mert, "", "https://push.example/mert")
	s.pushCrowd(1500)
	sender := &fakeSender{}
	p := s.pusher(sender, admin)
	ctx := context.Background()
	if _, err := p.Run(ctx); err != nil {
		t.Fatal(err)
	}
	s.send(admin, general, "first", "n-busy-1")
	s.send(admin, general, "second", "n-busy-2")
	s.send(admin, general, "hello <@"+s.userID(mert)+">", "n-busy-mert")
	n, err := p.Run(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got := distinctCalls(sender, "https://push.example/mert"); got["https://push.example/mert"] != 1 {
		t.Errorf("mert's push not in the same run (sent %d)", n)
	}
	if n != 3*1500+1 {
		t.Errorf("sent %d", n)
	}
}

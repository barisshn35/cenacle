// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"io"
	"log/slog"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/config"
	"github.com/Cenacle-TR/cenacle/server/internal/notify"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

func TestCallPushAndCallPrefs(t *testing.T) {
	shared := newShared(t)
	// Unique per run: the shared Valkey keeps a node for a minute.
	node := "test-media-push-" + uuid.NewString()[:8]
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	s := newStack(t, shared, options{pushKey: "BPUBLICKEY", calls: &config.Calls{Private: private, KeyID: "test-calls", NodeID: node}})
	ctx := context.Background()
	if err = shared.valkey.PutNew(ctx, "cenacle:media:node:"+node, []byte(uuid.NewString()), time.Minute); err != nil {
		t.Fatal(err)
	}
	if _, err = s.pool.Exec(ctx, "UPDATE workspaces SET calls_enabled = true WHERE id = $1", s.defaultWS); err != nil {
		t.Fatal(err)
	}
	ayse := s.user("cp-a", "Ayşe")
	mert := s.user("cp-m", "Mert")
	zeynep := s.user("cp-z", "Zeynep")

	// Calls ring by default; a client that does not send them keeps them.
	var set api.NotificationSettings
	s.call(http.MethodGet, "/api/me/notifications", mert, nil, &set)
	if !set.Prefs.Calls.Ring || !set.Prefs.Calls.Channel || set.Prefs.Calls.Sound != "marimba" {
		t.Fatalf("call defaults = %+v", set.Prefs.Calls)
	}
	for _, who := range []string{mert, zeynep} {
		s.call(http.MethodPut, "/api/me/notifications", who, map[string]any{
			"desktop": true, "push": true, "sounds": set.Prefs.Sounds, "volume": 70, "default_level": "all",
			"email": map[string]any{"enabled": false, "delay_minutes": 15}, "paused_until": nil,
			"quiet_hours": set.Prefs.QuietHours,
		}, nil)
		s.call(http.MethodPost, "/api/me/push-subscriptions", who, map[string]any{"endpoint": "https://push.example/" + who[:8], "keys": map[string]string{"p256dh": "k", "auth": "a"}}, nil)
	}
	s.call(http.MethodGet, "/api/me/notifications", mert, nil, &set)
	if !set.Prefs.Push || !set.Prefs.Calls.Ring {
		t.Fatalf("after an older client's save = %+v", set.Prefs)
	}

	sender := &fakeSender{}
	p := &notify.Pusher{Queries: store.New(s.pool), Push: sender, Presence: fakePresence{}, PublicURL: "http://chat.test",
		Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	if _, err := p.Run(ctx); err != nil { // the first run notes where messages start
		t.Fatal(err)
	}
	start := func(token, channel string) string {
		t.Helper()
		var c struct {
			ID string `json:"id"`
		}
		if res := s.call(http.MethodPost, "/api/channels/"+channel+"/calls", token, map[string]any{"nonce": uuid.NewString()}, &c); res.StatusCode != http.StatusCreated {
			t.Fatalf("start = %d", res.StatusCode)
		}
		return c.ID
	}
	// A direct call rings Mert's phone; a group call rings both.
	dm, _ := s.open(ayse, s.defaultWS, s.userID(mert))
	first := start(ayse, dm.ID)
	if n, err := p.Run(ctx); err != nil || n != 1 || sender.sent[0].Title != "Ayşe" || sender.sent[0].Body != "Incoming call / Gelen arama" {
		t.Fatalf("direct call push = %d %v %+v", n, err, sender.sent)
	}
	if n, _ := p.Run(ctx); n != 0 {
		t.Errorf("pushed twice: %d", n)
	}
	s.call(http.MethodPost, "/api/calls/"+first+"/leave", ayse, nil, nil)
	group, _ := s.open(ayse, s.defaultWS, s.userID(mert), s.userID(zeynep))
	second := start(ayse, group.ID)
	if n, _ := p.Run(ctx); n != 2 {
		t.Errorf("group call pushes = %d", n)
	}
	s.call(http.MethodPost, "/api/calls/"+second+"/leave", ayse, nil, nil)

	// Mert turns ringing off: Zeynep's phone still rings.
	set.Prefs.Calls.Ring = false
	if res := s.call(http.MethodPut, "/api/me/notifications", mert, set.Prefs, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("save = %d", res.StatusCode)
	}
	start(ayse, group.ID)
	before := len(sender.sent)
	if n, _ := p.Run(ctx); n != 1 || sender.sent[before].URL != "http://chat.test/c/"+group.ID {
		t.Errorf("with Mert's ringing off = %d %+v", n, sender.sent[before:])
	}
	set.Prefs.Calls.Sound = "trumpet"
	if status, _ := problemCode(t, s, http.MethodPut, "/api/me/notifications", mert, set.Prefs); status != http.StatusBadRequest {
		t.Errorf("unknown ring tone = %d", status)
	}
}

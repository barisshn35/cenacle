// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"testing"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/notify"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

// cuttingSender ends the run's context after its first push, like River's
// job timeout in the middle of a run.
type cuttingSender struct {
	fakeSender
	cancel context.CancelFunc
}

func (c *cuttingSender) Send(ctx context.Context, endpoint, p256dh, auth string, p notify.Payload) error {
	err := c.fakeSender.Send(ctx, endpoint, p256dh, auth, p)
	c.cancel()
	return err
}

// A run cut short keeps what it sent: the next run neither sends those
// pushes again nor skips the rest.
func TestWebPushRunCutShort(t *testing.T) {
	s := newStack(t, newShared(t), options{pushKey: "BPUBLICKEY"})
	ayse := s.user("sub-ayse", "Ayşe")
	mert := s.user("sub-mert", "Mert")
	general := s.general(ayse)
	var set api.NotificationSettings
	s.call(http.MethodGet, "/api/me/notifications", mert, nil, &set)
	set.Prefs.Push = true
	s.call(http.MethodPut, "/api/me/notifications", mert, set.Prefs, nil)
	if res := s.call(http.MethodPost, "/api/me/push-subscriptions", mert, map[string]any{"endpoint": "https://push.example/mert", "keys": map[string]string{"p256dh": "k", "auth": "a"}}, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("subscribe = %d", res.StatusCode)
	}
	sender := &cuttingSender{}
	p := &notify.Pusher{Queries: store.New(s.pool), Push: sender, Presence: fakePresence{s.userID(ayse): "online"},
		PublicURL: "http://chat.test", Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	if _, err := p.Run(context.Background()); err != nil { // notes where to start
		t.Fatal(err)
	}
	s.send(ayse, general, "first <@"+s.userID(mert)+">", "n-cut-01")
	s.send(ayse, general, "second <@"+s.userID(mert)+">", "n-cut-02")

	ctx, cancel := context.WithCancel(context.Background())
	sender.cancel = cancel
	// Cut after the first push (pushes go out side by side: one more may
	// have started already).
	if n, _ := p.Run(ctx); n < 1 {
		t.Fatalf("cut run sent %d", n)
	}
	sender.cancel = func() {}
	if _, err := p.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(sender.sent) != 2 || sender.sent[0].Body == sender.sent[1].Body {
		t.Fatalf("sent %d pushes: %+v", len(sender.sent), sender.sent)
	}
}

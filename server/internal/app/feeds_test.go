// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"testing"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/chat"
	"github.com/Cenacle-TR/cenacle/server/internal/egress"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

func rssWith(items ...string) string {
	var b strings.Builder
	b.WriteString(`<rss version="2.0"><channel><title>Sürüm notları</title>`)
	for _, it := range items {
		b.WriteString(`<item><title>` + it + `</title><link>https://example.com/` + it + `</link><guid>` + it + `</guid><description>Hakkında ` + it + `</description></item>`)
	}
	b.WriteString(`</channel></rss>`)
	return b.String()
}

func (s *stack) lastMessage(token, channelID string) api.Message {
	s.t.Helper()
	var page api.MessagePage
	s.call(http.MethodGet, "/api/channels/"+channelID+"/messages", token, nil, &page)
	if len(page.Messages) == 0 {
		s.t.Fatal("no messages")
	}
	return page.Messages[len(page.Messages)-1]
}

func TestFeedsAndWebhooks(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	general := s.general(admin)

	var mu sync.Mutex
	doc := rssWith("v2", "v1")
	feed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Content-Type", "application/rss+xml")
		_, _ = io.WriteString(w, doc)
	}))
	defer feed.Close()

	// Members cannot change feeds; managers subscribe, and what is there already is not posted.
	if r, _ := s.run(ayse, general, "feed", "subscribe "+feed.URL); !strings.Contains(r.Text, "managers") {
		t.Errorf("member subscribing = %q", r.Text)
	}
	if r, _ := s.run(admin, general, "feed", "subscribe "+feed.URL); !strings.Contains(r.Text, "Following Sürüm notları") {
		t.Fatalf("subscribe = %q", r.Text)
	}
	if r, _ := s.run(admin, general, "feed", "subscribe "+feed.URL); !strings.Contains(r.Text, "already") {
		t.Errorf("twice = %q", r.Text)
	}
	if r, _ := s.run(admin, general, "feed", "list"); !strings.Contains(r.Text, feed.URL) {
		t.Errorf("list = %q", r.Text)
	}

	// A new item is posted once, by the workspace's Cenacle bot.
	mu.Lock()
	doc = rssWith("v3", "v2", "v1")
	mu.Unlock()
	if _, err := s.pool.Exec(context.Background(), "UPDATE channel_feeds SET checked_at = now() - interval '1 hour'"); err != nil {
		t.Fatal(err)
	}
	reader := &chat.FeedReader{DB: s.pool, Queries: store.New(s.pool), Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Egress: egress.New(egress.Policy{Allow: []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}, AllowHTTP: true})}
	if n, err := reader.Run(context.Background()); err != nil || n != 1 {
		t.Fatalf("read = %d %v", n, err)
	}
	m := s.lastMessage(admin, general)
	if m.Author.DisplayName != "Cenacle" || *m.Attachments[0].Title != "v3" || *m.Attachments[0].Footer != "Sürüm notları" {
		t.Errorf("posted = %+v", m)
	}
	if n, _ := reader.Run(context.Background()); n != 0 {
		t.Errorf("read again at once = %d", n)
	}
	if r, _ := s.run(admin, general, "feed", "unsubscribe "+feed.URL); !strings.Contains(r.Text, "No longer") {
		t.Errorf("unsubscribe = %q", r.Text)
	}

	// GitHub and e-mail webhooks post cards.
	b := s.newBot(admin, "Kaynaklar")
	var gh, mail struct {
		URL string `json:"url"`
	}
	s.call(http.MethodPost, "/api/bots/"+b.ID+"/webhooks", admin, map[string]string{"name": "GitHub", "channel_id": general, "kind": "github"}, &gh)
	s.call(http.MethodPost, "/api/bots/"+b.ID+"/webhooks", admin, map[string]string{"name": "Posta", "channel_id": general, "kind": "email"}, &mail)
	s.call(http.MethodPost, "/api/channels/"+general+"/members", admin, map[string]string{"user_id": b.UserID}, nil)
	req, _ := http.NewRequest(http.MethodPost, gh.URL, strings.NewReader(`{"action":"opened","issue":{"number":3,"title":"Crash","html_url":"https://github.com/acme/api/issues/3"},"repository":{"full_name":"acme/api"},"sender":{"login":"ayse"}}`))
	req.Header.Set("X-GitHub-Event", "issues")
	res, err := s.client.Do(req)
	if err != nil || res.StatusCode != http.StatusOK {
		t.Fatalf("github hook = %v %v", res, err)
	}
	_ = res.Body.Close()
	if m := s.lastMessage(admin, general); *m.Attachments[0].Title != "#3 Crash" {
		t.Errorf("github card = %+v", m.Attachments)
	}
	if res := s.raw(http.MethodPost, mail.URL, "", "From: ops@example.com\r\nSubject: Disk\r\n\r\nDisk 90% full\r\n"); res.StatusCode != http.StatusOK {
		t.Fatalf("mail hook = %d", res.StatusCode)
	}
	if m := s.lastMessage(admin, general); *m.Attachments[0].Title != "Disk" || *m.Attachments[0].Text != "Disk 90% full" {
		t.Errorf("mail card = %+v", m.Attachments)
	}
}

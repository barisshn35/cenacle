// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/notify"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

type searchPage struct {
	Results []api.SearchMessage `json:"results"`
	HasMore bool                `json:"has_more"`
}

func (s *stack) search(token, query string) searchPage {
	s.t.Helper()
	var out searchPage
	if res := s.call(http.MethodGet, "/api/search/messages?"+query, token, nil, &out); res.StatusCode != http.StatusOK {
		s.t.Fatalf("search %s = %d", query, res.StatusCode)
	}
	return out
}

func TestSearchMessages(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ayse := s.user("sub-ayse", "Ayşe")
	mert := s.user("sub-mert", "Mert")
	general := s.general(ayse)
	s.send(ayse, general, "Yarınki TOPLANTI İstanbul’da", "n-search-1")
	s.send(mert, general, "Toplantı iptal oldu, ayrıntılar https://example.com/not", "n-search-2")
	s.send(ayse, general, "Öğle yemeği?", "n-search-3")

	q := func(v string) string { return "q=" + url.QueryEscape(v) }
	// Accents, dotted İ and case do not matter; words match their beginning.
	if r := s.search(mert, q("istanbul toplan")); len(r.Results) != 1 || !strings.Contains(r.Results[0].Body, "İstanbul") {
		t.Errorf("istanbul toplan = %+v", r.Results)
	}
	if r := s.search(mert, q("toplanti")); len(r.Results) != 2 {
		t.Errorf("toplanti = %d results", len(r.Results))
	}
	// "-word" leaves out; filters by person and links.
	if r := s.search(mert, q("toplanti -iptal")); len(r.Results) != 1 {
		t.Errorf("toplanti -iptal = %d results", len(r.Results))
	}
	if r := s.search(ayse, q("toplanti")+"&from="+s.userID(mert)); len(r.Results) != 1 || r.Results[0].Author.DisplayName != "Mert" {
		t.Errorf("from mert = %+v", r.Results)
	}
	if r := s.search(ayse, q("toplanti")+"&has=link"); len(r.Results) != 1 {
		t.Errorf("has link = %d results", len(r.Results))
	}
	if r := s.search(ayse, q("ogle")); len(r.Results) != 1 || r.Results[0].Channel.Name != "General" {
		t.Errorf("ogle = %+v", r.Results)
	}
	// Paging: newest first, one at a time.
	first := s.search(ayse, q("toplanti")+"&limit=1")
	if len(first.Results) != 1 || !first.HasMore {
		t.Fatalf("first page = %+v", first)
	}
	second := s.search(ayse, q("toplanti")+"&limit=1&before="+first.Results[0].Id.String())
	if len(second.Results) != 1 || second.HasMore || second.Results[0].Id == first.Results[0].Id {
		t.Errorf("second page = %+v", second)
	}
	// Channels one is not in stay out.
	var secret channel
	s.call(http.MethodPost, "/api/channels", ayse, map[string]any{"name": "Gizli", "visibility": "private"}, &secret)
	s.send(ayse, secret.ID, "toplanti gizli", "n-search-4")
	if r := s.search(mert, q("gizli")); len(r.Results) != 0 {
		t.Errorf("someone else's private channel: %+v", r.Results)
	}
	// Nothing to search for.
	if status, _ := problemCode(t, s, http.MethodGet, "/api/search/messages?"+q("?? !!"), ayse, nil); status != http.StatusBadRequest {
		t.Errorf("punctuation only = %d", status)
	}
}

func TestNotificationSettings(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ayse := s.user("sub-ayse", "Ayşe")
	general := s.general(ayse)

	var set api.NotificationSettings
	s.call(http.MethodGet, "/api/me/notifications", ayse, nil, &set)
	if !set.Prefs.Desktop || set.Prefs.Sounds.Mention != "chime" || set.Prefs.DefaultLevel != "mentions" || set.PushPublicKey != nil || set.EmailAvailable {
		t.Fatalf("defaults = %+v", set)
	}
	prefs := set.Prefs
	prefs.Sounds.Message, prefs.Volume = "marimba", 40
	prefs.QuietHours.Enabled = true
	if res := s.call(http.MethodPut, "/api/me/notifications", ayse, prefs, &set); res.StatusCode != http.StatusOK || set.Prefs.Volume != 40 || !set.Prefs.QuietHours.Enabled {
		t.Errorf("save = %d %+v", res.StatusCode, set.Prefs)
	}
	bad := prefs
	bad.Sounds.Mention = "siren"
	if status, _ := problemCode(t, s, http.MethodPut, "/api/me/notifications", ayse, bad); status != http.StatusBadRequest {
		t.Errorf("unknown sound = %d", status)
	}

	// Muting a channel and a workspace shows in the settings.
	until := time.Now().Add(time.Hour).UTC().Truncate(time.Second)
	if res := s.call(http.MethodPut, "/api/channels/"+general+"/notifications", ayse, map[string]any{"level": "all", "muted_until": until, "sound": "bell"}, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("channel = %d", res.StatusCode)
	}
	s.call(http.MethodPut, "/api/workspaces/"+s.defaultWS+"/notifications", ayse, map[string]any{"muted_until": until}, nil)
	s.call(http.MethodGet, "/api/me/notifications", ayse, nil, &set)
	if len(set.Channels) != 1 || set.Channels[0].Level != "all" || set.Channels[0].Sound != "bell" || len(set.Workspaces) != 1 {
		t.Errorf("mutes = %+v %+v", set.Channels, set.Workspaces)
	}
	// Unmuted channel with defaults again: not listed.
	s.call(http.MethodPut, "/api/channels/"+general+"/notifications", ayse, map[string]any{"level": "default", "muted_until": nil, "sound": ""}, nil)
	s.call(http.MethodGet, "/api/me/notifications", ayse, nil, &set)
	if len(set.Channels) != 0 {
		t.Errorf("after unmuting = %+v", set.Channels)
	}
	// Push is off on this installation.
	if status, _ := problemCode(t, s, http.MethodPost, "/api/me/push-subscriptions", ayse, map[string]any{"endpoint": "https://push.example.com/x", "keys": map[string]string{"p256dh": "a", "auth": "b"}}); status != http.StatusNotFound {
		t.Errorf("push without web push = %d", status)
	}
}

func TestUserSounds(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ayse := s.user("sub-ayse", "Ayşe")
	mert := s.user("sub-mert", "Mert")
	wav := append([]byte("RIFF\x24\x00\x00\x00WAVEfmt "), bytes.Repeat([]byte{0}, 40)...)
	res, body := s.upload(http.MethodPost, "/api/me/sounds?name=Gong", ayse, wav)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("upload = %d %s", res.StatusCode, body)
	}
	var list struct {
		Sounds []api.UserSound `json:"sounds"`
	}
	s.call(http.MethodGet, "/api/me/sounds", ayse, nil, &list)
	if len(list.Sounds) != 1 || list.Sounds[0].ContentType != "audio/wav" {
		t.Fatalf("sounds = %+v", list)
	}
	id := list.Sounds[0].Id.String()
	if status, hdr, _ := s.get(ayse, "/api/sounds/"+id); status != http.StatusOK || hdr.Get("Content-Type") != "audio/wav" {
		t.Errorf("own sound = %d", status)
	}
	if status, _, _ := s.get(mert, "/api/sounds/"+id); status != http.StatusNotFound {
		t.Errorf("someone else's sound = %d", status)
	}
	if res, _ := s.upload(http.MethodPost, "/api/me/sounds?name=x", ayse, []byte("not audio")); res.StatusCode != http.StatusUnprocessableEntity {
		t.Errorf("not audio = %d", res.StatusCode)
	}
	// Choosing it as a sound.
	var set api.NotificationSettings
	s.call(http.MethodGet, "/api/me/notifications", ayse, nil, &set)
	set.Prefs.Sounds.Direct = "user:" + id
	if res := s.call(http.MethodPut, "/api/me/notifications", ayse, set.Prefs, nil); res.StatusCode != http.StatusOK {
		t.Errorf("own sound as direct sound = %d", res.StatusCode)
	}
}

// --- web push ------------------------------------------------------------------

type fakeSender struct {
	mu    sync.Mutex
	sent  []notify.Payload
	gone  map[string]bool
	calls []string
}

func (f *fakeSender) Send(_ context.Context, endpoint, _, _ string, p notify.Payload) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, endpoint)
	if f.gone[endpoint] {
		return notify.ErrGone
	}
	f.sent = append(f.sent, p)
	return nil
}

type fakePresence map[string]string

func (f fakePresence) Statuses(context.Context, []string) (map[string]string, error) { return f, nil }

func TestWebPush(t *testing.T) {
	s := newStack(t, newShared(t), options{pushKey: "BPUBLICKEY"})
	ayse := s.user("sub-ayse", "Ayşe")
	mert := s.user("sub-mert", "Mert")
	deniz := s.user("sub-deniz", "Deniz")
	general := s.general(ayse)

	var set api.NotificationSettings
	s.call(http.MethodGet, "/api/me/notifications", mert, nil, &set)
	if set.PushPublicKey == nil || *set.PushPublicKey != "BPUBLICKEY" {
		t.Fatalf("public key = %v", set.PushPublicKey)
	}
	for _, who := range []string{mert, deniz} {
		set.Prefs.Push = true
		s.call(http.MethodPut, "/api/me/notifications", who, set.Prefs, nil)
	}
	sub := func(token, endpoint string) {
		t.Helper()
		if res := s.call(http.MethodPost, "/api/me/push-subscriptions", token, map[string]any{"endpoint": endpoint, "keys": map[string]string{"p256dh": "k", "auth": "a"}}, nil); res.StatusCode != http.StatusNoContent {
			t.Fatalf("subscribe = %d", res.StatusCode)
		}
	}
	if status, _ := problemCode(t, s, http.MethodPost, "/api/me/push-subscriptions", mert, map[string]any{"endpoint": "http://127.0.0.1/x", "keys": map[string]string{"p256dh": "k", "auth": "a"}}); status != http.StatusBadRequest {
		t.Errorf("http endpoint = %d", status)
	}
	sub(mert, "https://push.example/mert")
	sub(deniz, "https://push.example/deniz-gone")

	sender := &fakeSender{gone: map[string]bool{"https://push.example/deniz-gone": true}}
	presence := fakePresence{s.userID(ayse): "online"}
	p := &notify.Pusher{Queries: store.New(s.pool), Push: sender, Presence: presence, PublicURL: "http://chat.test",
		Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	ctx := context.Background()
	if _, err := p.Run(ctx); err != nil { // the first run only notes where to start
		t.Fatal(err)
	}
	s.send(ayse, general, "hello <@"+s.userID(mert)+"> and <@"+s.userID(deniz)+">", "n-push-1")
	s.send(ayse, general, "no mention here", "n-push-2")
	if n, err := p.Run(ctx); err != nil || n != 1 {
		t.Fatalf("run = %d, %v", n, err)
	}
	if len(sender.sent) != 1 || sender.sent[0].Title != "Ayşe · General" || !strings.Contains(sender.sent[0].URL, "/c/"+general) {
		t.Errorf("sent = %+v", sender.sent)
	}
	// The gone subscription was removed; nothing is sent twice.
	var n int
	if err := s.pool.QueryRow(ctx, "SELECT count(*) FROM push_subscriptions").Scan(&n); err != nil || n != 1 {
		t.Errorf("subscriptions left = %d %v", n, err)
	}
	if n, _ := p.Run(ctx); n != 0 {
		t.Errorf("second run sent %d", n)
	}
	// Muted: no push; online: no push.
	mute := time.Now().Add(time.Hour)
	s.call(http.MethodPut, "/api/channels/"+general+"/notifications", mert, map[string]any{"level": "default", "muted_until": mute, "sound": ""}, nil)
	s.send(ayse, general, "again <@"+s.userID(mert)+">", "n-push-3")
	if n, _ := p.Run(ctx); n != 0 {
		t.Errorf("muted channel sent %d", n)
	}
	s.call(http.MethodPut, "/api/channels/"+general+"/notifications", mert, map[string]any{"level": "default", "muted_until": nil, "sound": ""}, nil)
	presence[s.userID(mert)] = "online"
	s.send(ayse, general, "once more <@"+s.userID(mert)+">", "n-push-4")
	if n, _ := p.Run(ctx); n != 0 {
		t.Errorf("online person got %d pushes", n)
	}
	// The notification policy keeps the text (and then the sender) off lock screens.
	presence[s.userID(mert)] = ""
	if _, err := s.pool.Exec(ctx, "UPDATE instance_settings SET push_contents = 'sender'"); err != nil {
		t.Fatal(err)
	}
	s.send(ayse, general, "secret plan <@"+s.userID(mert)+">", "n-push-5")
	if n, _ := p.Run(ctx); n != 1 {
		t.Fatalf("sender policy sent %d", n)
	}
	if got := sender.sent[len(sender.sent)-1]; got.Body != "" || got.Title != "Ayşe · General" {
		t.Errorf("sender policy = %+v", got)
	}
	if _, err := s.pool.Exec(ctx, "UPDATE instance_settings SET push_contents = 'none'"); err != nil {
		t.Fatal(err)
	}
	s.send(ayse, general, "secret plan 2 <@"+s.userID(mert)+">", "n-push-6")
	_, _ = p.Run(ctx)
	if got := sender.sent[len(sender.sent)-1]; got.Title != "Cenacle" || strings.Contains(got.Body, "secret") {
		t.Errorf("none policy = %+v", got)
	}
}

// --- e-mail ------------------------------------------------------------------------

// fakeSMTP accepts one message at a time and keeps what it received.
type fakeSMTP struct {
	ln   net.Listener
	mu   sync.Mutex
	mail []string
}

func newFakeSMTP(t *testing.T) *fakeSMTP {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeSMTP{ln: ln}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go f.serve(c)
		}
	}()
	return f
}

func (f *fakeSMTP) serve(c net.Conn) {
	defer func() { _ = c.Close() }()
	r := bufio.NewReader(c)
	say := func(s string) { _, _ = io.WriteString(c, s+"\r\n") }
	say("220 fake")
	var data strings.Builder
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return
		}
		cmd := strings.ToUpper(strings.TrimSpace(line))
		switch {
		case strings.HasPrefix(cmd, "EHLO"), strings.HasPrefix(cmd, "HELO"):
			say("250 fake")
		case strings.HasPrefix(cmd, "DATA"):
			say("354 go on")
			for {
				l, err := r.ReadString('\n')
				if err != nil {
					return
				}
				if l == ".\r\n" {
					break
				}
				data.WriteString(l)
			}
			f.mu.Lock()
			f.mail = append(f.mail, data.String())
			f.mu.Unlock()
			say("250 queued")
		case strings.HasPrefix(cmd, "QUIT"):
			say("221 bye")
			return
		default:
			say("250 ok")
		}
	}
}

func TestEmailNotifications(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ayse := s.user("sub-ayse", "Ayşe")
	mert := s.user("sub-mert", "Mert")
	general := s.general(ayse)
	var set api.NotificationSettings
	s.call(http.MethodGet, "/api/me/notifications", mert, nil, &set)
	set.Prefs.Email.Enabled, set.Prefs.Email.DelayMinutes = true, 5
	s.call(http.MethodPut, "/api/me/notifications", mert, set.Prefs, nil)

	smtpd := newFakeSMTP(t)
	_, port, _ := net.SplitHostPort(smtpd.ln.Addr().String())
	now := time.Now()
	e := &notify.Emailer{
		Queries: store.New(s.pool), Presence: fakePresence{}, PublicURL: "http://chat.test",
		Log:  slog.New(slog.NewTextHandler(io.Discard, nil)),
		SMTP: &notify.SMTP{Host: "127.0.0.1", Port: atoi(t, port), From: "Cenacle <chat@example.com>", Security: "none"},
		Now:  func() time.Time { return now },
	}
	ctx := context.Background()
	s.send(ayse, general, "Merhaba <@"+s.userID(mert)+">, rapor hazır mı?", "n-mail-1")
	s.send(ayse, general, "plain message", "n-mail-2")
	// Too early: the delay has not passed.
	if n, err := e.Run(ctx); err != nil || n != 0 {
		t.Fatalf("early run = %d, %v", n, err)
	}
	now = now.Add(6 * time.Minute)
	if n, err := e.Run(ctx); err != nil || n != 1 {
		t.Fatalf("run = %d, %v", n, err)
	}
	if got := smtpd.mail[0]; !strings.Contains(got, "rapor haz") || strings.Contains(got, "plain message") || !strings.Contains(got, "To: <sub-mert@example.com>") {
		t.Errorf("mail = %s", got)
	}
	// Told once.
	if n, _ := e.Run(ctx); n != 0 {
		t.Errorf("second run sent %d", n)
	}
}

func atoi(t *testing.T, s string) int {
	t.Helper()
	n := 0
	for _, c := range s {
		n = n*10 + int(c-'0')
	}
	return n
}

// A push subscription ends with the session that made it.
func TestPushEndsWithSession(t *testing.T) {
	s := newStack(t, newShared(t), options{pushKey: "BPUBLICKEY"})
	ayse := s.user("sub-a", "Ayşe")
	lost := s.user("sub-m", "Mert")
	kept := s.user("sub-m", "Mert")
	deniz := s.user("sub-d", "Deniz")
	general := s.general(ayse)
	var set api.NotificationSettings
	s.call(http.MethodGet, "/api/me/notifications", lost, nil, &set)
	set.Prefs.Push = true
	s.call(http.MethodPut, "/api/me/notifications", lost, set.Prefs, nil)
	sub := map[string]any{"endpoint": "https://push.example/lost", "keys": map[string]string{"p256dh": "k", "auth": "a"}}
	if res := s.call(http.MethodPost, "/api/me/push-subscriptions", lost, sub, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("subscribe = %d", res.StatusCode)
	}
	// Another person cannot take over the endpoint of a signed-in browser.
	if status, _ := problemCode(t, s, http.MethodPost, "/api/me/push-subscriptions", deniz, sub); status != http.StatusBadRequest {
		t.Errorf("takeover = %d", status)
	}
	var list struct{ Sessions []api.DeviceSession }
	s.call(http.MethodGet, "/api/sessions", kept, nil, &list)
	for _, x := range list.Sessions {
		if !x.Current {
			if res := s.call(http.MethodDelete, "/api/sessions/"+x.Id.String(), kept, nil, nil); res.StatusCode != http.StatusNoContent {
				t.Fatalf("end session = %d", res.StatusCode)
			}
		}
	}
	ctx := context.Background()
	var n int
	if err := s.pool.QueryRow(ctx, "SELECT count(*) FROM push_subscriptions").Scan(&n); err != nil || n != 0 {
		t.Errorf("subscriptions left = %d %v", n, err)
	}
	sender := &fakeSender{}
	p := &notify.Pusher{Queries: store.New(s.pool), Push: sender, Presence: fakePresence{s.userID(ayse): "online"},
		PublicURL: "http://chat.test", Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	if _, err := p.Run(ctx); err != nil {
		t.Fatal(err)
	}
	s.send(ayse, general, "hello <@"+s.userID(kept)+">", "n-push-lost")
	if _, err := p.Run(ctx); err != nil {
		t.Fatal(err)
	}
	if len(sender.calls) != 0 {
		t.Errorf("pushed to an ended session: %v", sender.calls)
	}
	// Once its session is gone the endpoint is free again.
	if res := s.call(http.MethodPost, "/api/me/push-subscriptions", deniz, sub, nil); res.StatusCode != http.StatusNoContent {
		t.Errorf("subscribe after sign-out = %d", res.StatusCode)
	}
}

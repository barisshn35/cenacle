// SPDX-License-Identifier: Apache-2.0

package app_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/barisshn35/cenacle/server/internal/app"
	"github.com/barisshn35/cenacle/server/internal/auth"
	"github.com/barisshn35/cenacle/server/internal/cache"
	"github.com/barisshn35/cenacle/server/internal/chat"
	"github.com/barisshn35/cenacle/server/internal/events"
	"github.com/barisshn35/cenacle/server/internal/realtime"
	"github.com/barisshn35/cenacle/server/internal/store"
	"github.com/barisshn35/cenacle/server/internal/testdb"
)

// stack is one chat server instance; several can share database and Valkey.
type stack struct {
	t        *testing.T
	srv      *httptest.Server
	pool     *pgxpool.Pool
	sessions *auth.Sessions
	hub      *realtime.Hub
	client   *http.Client
}

type shared struct {
	pool   *pgxpool.Pool
	valkey *cache.Client
	stream string
}

func newShared(t *testing.T) shared {
	t.Helper()
	vk := testdb.Valkey(t)
	sh := shared{pool: testdb.Open(t), valkey: vk, stream: "test:events:" + testdb.Suffix()}
	t.Cleanup(func() {
		vc, _ := vk.Get()
		vc.Do(context.Background(), vc.B().Del().Key(sh.stream).Build())
	})
	// As at installation: Central for announcements, General for everyone.
	if err := chat.EnsureDefaults(context.Background(), store.New(sh.pool), chat.Defaults{
		Announcement: "Central", Channels: []string{"General"}, AdminEmail: adminEmail,
	}); err != nil {
		t.Fatal(err)
	}
	return sh
}

type options struct {
	settings    realtime.Settings
	perWindow   int64
	maxLen      int64
	httpTimeout time.Duration
}

func newStack(t *testing.T, sh shared, o options) *stack {
	t.Helper()
	if o.settings == (realtime.Settings{}) {
		o.settings = realtime.Settings{Heartbeat: time.Second, SessionCheck: time.Second, QueueSize: 64, MaxBacklog: 50}
	}
	if o.perWindow == 0 {
		o.perWindow = 100
	}
	if o.maxLen == 0 {
		o.maxLen = 1000
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	queries := store.New(sh.pool)
	sessions := &auth.Sessions{Queries: queries, IdleTimeout: time.Hour, MaxAge: 24 * time.Hour}
	eventLog := &events.Log{Valkey: sh.valkey, Key: sh.stream, MaxLen: o.maxLen}
	hub := &realtime.Hub{Log: eventLog, Logger: log}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go hub.Run(ctx)

	var router http.Handler
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		router.ServeHTTP(w, r)
	}))
	if o.httpTimeout > 0 {
		srv.Config.ReadTimeout, srv.Config.WriteTimeout = o.httpTimeout, o.httpTimeout
	}
	srv.Start()
	t.Cleanup(srv.Close)
	public, _ := url.Parse(srv.URL)
	cookies := auth.NewCookies(public)
	router = app.NewRouter(app.Deps{
		Log: log,
		Auth: &auth.Handlers{
			IdP:      &auth.IdentityProvider{Issuer: "http://127.0.0.1:1", HTTPClient: http.DefaultClient},
			Sessions: sessions, Users: queries, Cookies: cookies, PublicURL: public, Log: log,
		},
		Chat: &chat.Handlers{
			Queries: queries, Events: eventLog, Limiter: sh.valkey, Cookies: cookies, Log: log,
			MessagesPerWindow: o.perWindow, Window: 10 * time.Second, Configured: []string{"Central", "General"},
		},
		Realtime: &realtime.Handler{
			Hub: hub, Tickets: sh.valkey, Sessions: sessions, Members: queries, Cookies: cookies, PublicURL: public,
			Settings: o.settings, Log: log,
		},
	})
	// With short server timeouts, idle keep-alive connections are closed under
	// the client; a reused one would fail a POST with EOF.
	client := &http.Client{Transport: &http.Transport{DisableKeepAlives: o.httpTimeout > 0}}
	t.Cleanup(client.CloseIdleConnections)
	s := &stack{t: t, srv: srv, pool: sh.pool, sessions: sessions, hub: hub, client: client}
	// Wait until the hub follows the log, so no event published by a test is missed.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := eventLog.State(context.Background()); err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	time.Sleep(100 * time.Millisecond)
	return s
}

// user signs a user in directly (the OIDC flow is tested in package auth)
// and returns a bearer token.
// adminEmail is the administrator's address in these tests.
const adminEmail = "admin@example.com"

func (s *stack) user(subject, name string) string {
	return s.userWithEmail(subject, name, subject+"@example.com")
}

func (s *stack) admin() string { return s.userWithEmail("sub-admin", "Yönetici", adminEmail) }

func (s *stack) userWithEmail(subject, name, email string) string {
	s.t.Helper()
	ctx := context.Background()
	q := store.New(s.pool)
	u, err := q.UpsertUserFromIdentity(ctx, store.UpsertUserFromIdentityParams{
		AuthService: "cenacle-id", AuthData: subject, Email: email, DisplayName: name, EmailVerified: true,
	})
	if err != nil {
		s.t.Fatal(err)
	}
	// What sign-in does after the OIDC flow (tested in package auth).
	if _, err := q.JoinDefaultChannels(ctx, u.ID); err != nil {
		s.t.Fatal(err)
	}
	if email == adminEmail {
		if err := q.SetAdmin(ctx, store.SetAdminParams{ID: u.ID, IsAdmin: true}); err != nil {
			s.t.Fatal(err)
		}
	}
	token, _, err := s.sessions.Create(ctx, u.ID, auth.ClientInfo{})
	if err != nil {
		s.t.Fatal(err)
	}
	return token
}

func (s *stack) call(method, path, token string, body any, out any) *http.Response {
	s.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, s.srv.URL+path, rd)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := s.client.Do(req)
	if err != nil {
		s.t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	raw, _ := io.ReadAll(res.Body)
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			s.t.Fatalf("%s %s: %d %s", method, path, res.StatusCode, raw)
		}
	}
	return res
}

type channel struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Kind        string `json:"kind"`
	IsDefault   bool   `json:"is_default"`
	IsMandatory bool   `json:"is_mandatory"`
	IsMember    bool   `json:"is_member"`
	CanPost     bool   `json:"can_post"`
}

type message struct {
	ID        string `json:"id"`
	ChannelID string `json:"channel_id"`
	Body      string `json:"body"`
	Nonce     string `json:"nonce"`
	Author    struct {
		ID          string `json:"id"`
		DisplayName string `json:"display_name"`
	} `json:"author"`
}

func (s *stack) channels(token, path string) []channel {
	s.t.Helper()
	var out struct{ Channels []channel }
	if res := s.call(http.MethodGet, path, token, nil, &out); res.StatusCode != http.StatusOK {
		s.t.Fatalf("GET %s = %d", path, res.StatusCode)
	}
	return out.Channels
}

func (s *stack) channelID(token, name string) string {
	s.t.Helper()
	for _, c := range s.channels(token, "/api/channels") {
		if c.Name == name {
			return c.ID
		}
	}
	s.t.Fatalf("not a member of %s", name)
	return ""
}

func (s *stack) general(token string) string { return s.channelID(token, "General") }

func (s *stack) send(token, channelID, body, nonce string) (message, *http.Response) {
	s.t.Helper()
	var m message
	res := s.call(http.MethodPost, "/api/channels/"+channelID+"/messages", token,
		map[string]string{"body": body, "nonce": nonce}, &m)
	return m, res
}

func TestMessagesAndPagination(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	token := s.user("sub-a", "Ayşe")
	general := s.general(token)

	var sent []message
	for i, body := range []string{"one", "  two\n", "three", "four", "five"} {
		m, res := s.send(token, general, body, "nonce-000"+string(rune('0'+i)))
		if res.StatusCode != http.StatusCreated {
			t.Fatalf("send %q = %d", body, res.StatusCode)
		}
		sent = append(sent, m)
	}
	if sent[1].Body != "two" || sent[0].Author.DisplayName != "Ayşe" {
		t.Errorf("message = %+v", sent[1])
	}

	var page struct {
		Messages []message `json:"messages"`
		HasMore  bool      `json:"has_more"`
	}
	s.call(http.MethodGet, "/api/channels/"+general+"/messages?limit=2", token, nil, &page)
	if len(page.Messages) != 2 || page.Messages[0].Body != "four" || page.Messages[1].Body != "five" || !page.HasMore {
		t.Fatalf("newest page = %+v", page)
	}
	s.call(http.MethodGet, "/api/channels/"+general+"/messages?limit=2&before="+page.Messages[0].ID, token, nil, &page)
	if len(page.Messages) != 2 || page.Messages[0].Body != "two" || !page.HasMore {
		t.Fatalf("second page = %+v", page)
	}
	s.call(http.MethodGet, "/api/channels/"+general+"/messages?before="+page.Messages[0].ID, token, nil, &page)
	if len(page.Messages) != 1 || page.Messages[0].Body != "one" || page.HasMore {
		t.Fatalf("last page = %+v", page)
	}
}

func TestSendIsIdempotentAndValidated(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	token := s.user("sub-a", "Ayşe")
	general := s.general(token)

	first, _ := s.send(token, general, "hello", "retry-nonce-1")
	again, res := s.send(token, general, "hello", "retry-nonce-1")
	if res.StatusCode != http.StatusCreated || again.ID != first.ID {
		t.Errorf("retry created another message: %s vs %s", again.ID, first.ID)
	}

	for name, tc := range map[string]struct{ body, nonce string }{
		"empty":    {"  \n ", "nonce-empty"},
		"too long": {strings.Repeat("ç", 4001), "nonce-long1"},
		"nul":      {"a\x00b", "nonce-nul01"},
		"short id": {"hi", "short"},
	} {
		if _, res := s.send(token, general, tc.body, tc.nonce); res.StatusCode != http.StatusBadRequest {
			t.Errorf("%s: status %d, want 400", name, res.StatusCode)
		}
	}
	if _, res := s.send(token, general, strings.Repeat("ç", 4000), "nonce-max01"); res.StatusCode != http.StatusCreated {
		t.Errorf("4000 characters: %d", res.StatusCode)
	}
	if _, res := s.send(token, "0190aaaa-0000-7000-8000-000000000000", "hi", "nonce-404-1"); res.StatusCode != http.StatusNotFound {
		t.Errorf("unknown channel: %d", res.StatusCode)
	}
	if _, res := s.send("", general, "hi", "nonce-anon1"); res.StatusCode != http.StatusUnauthorized {
		t.Errorf("signed out: %d", res.StatusCode)
	}
	if res := s.call(http.MethodGet, "/api/channels", "", nil, nil); res.StatusCode != http.StatusUnauthorized {
		t.Errorf("signed-out channel list: %d", res.StatusCode)
	}
}

func TestSendRateLimit(t *testing.T) {
	s := newStack(t, newShared(t), options{perWindow: 3})
	token := s.user("sub-"+testdb.Suffix(), "Ayşe")
	general := s.general(token)
	for i := range 3 {
		if _, res := s.send(token, general, "hi", "rate-nonce-"+string(rune('a'+i))); res.StatusCode != http.StatusCreated {
			t.Fatalf("message %d: %d", i, res.StatusCode)
		}
	}
	_, res := s.send(token, general, "hi", "rate-nonce-z")
	if res.StatusCode != http.StatusTooManyRequests || res.Header.Get("Retry-After") == "" {
		t.Errorf("4th message = %d, Retry-After %q", res.StatusCode, res.Header.Get("Retry-After"))
	}
}

// --- WebSocket ------------------------------------------------------------

type frame struct {
	Op          string          `json:"op"`
	ID          string          `json:"id"`
	Type        string          `json:"type"`
	Data        json.RawMessage `json:"data"`
	LastEventID string          `json:"last_event_id"`
}

func (s *stack) ticket(token string) string {
	s.t.Helper()
	var out struct {
		Ticket    string `json:"ticket"`
		ExpiresIn int    `json:"expires_in"`
	}
	if res := s.call(http.MethodPost, "/api/ws/ticket", token, nil, &out); res.StatusCode != http.StatusCreated || out.ExpiresIn != 30 {
		s.t.Fatalf("ticket = %d %+v", res.StatusCode, out)
	}
	return out.Ticket
}

func (s *stack) dial(ticket, lastEventID string) (*websocket.Conn, *http.Response, error) {
	q := url.Values{"ticket": {ticket}}
	if lastEventID != "" {
		q.Set("last_event_id", lastEventID)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return websocket.Dial(ctx, "ws"+strings.TrimPrefix(s.srv.URL, "http")+"/ws?"+q.Encode(),
		&websocket.DialOptions{HTTPHeader: http.Header{"Origin": {s.srv.URL}}})
}

func (s *stack) connect(token, lastEventID string) *websocket.Conn {
	s.t.Helper()
	c, _, err := s.dial(s.ticket(token), lastEventID)
	if err != nil {
		s.t.Fatal(err)
	}
	s.t.Cleanup(func() { _ = c.CloseNow() })
	return c
}

func read(t *testing.T, c *websocket.Conn) frame {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, raw, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var f frame
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

func closeStatus(t *testing.T, c *websocket.Conn) websocket.StatusCode {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		if _, _, err := c.Read(ctx); err != nil {
			return websocket.CloseStatus(err)
		}
	}
}

func TestLiveMessagesAcrossInstances(t *testing.T) {
	sh := newShared(t)
	a := newStack(t, sh, options{})
	b := newStack(t, sh, options{})
	ayse := a.user("sub-a", "Ayşe")
	mert := b.user("sub-m", "Mert")
	general := a.general(ayse)

	conn := a.connect(ayse, "")
	hello := read(t, conn)
	if hello.Op != "hello" || hello.LastEventID == "" {
		t.Fatalf("hello = %+v", hello)
	}

	// Mert sends through the other instance; Ayşe's connection gets it.
	sent, _ := b.send(mert, general, "merhaba", "live-nonce-1")
	ev := read(t, conn)
	var got message
	_ = json.Unmarshal(ev.Data, &got)
	if ev.Op != "event" || ev.Type != "message.created" || got.ID != sent.ID || got.Body != "merhaba" ||
		got.Author.DisplayName != "Mert" || got.Nonce != "live-nonce-1" {
		t.Fatalf("event = %+v %+v", ev, got)
	}
}

func TestResumeAndResync(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	token := s.user("sub-a", "Ayşe")
	general := s.general(token)

	conn := s.connect(token, "")
	start := read(t, conn).LastEventID
	_ = conn.Close(websocket.StatusNormalClosure, "")

	// Two messages while disconnected arrive on resume, in order.
	first, _ := s.send(token, general, "while away 1", "resume-nonce-1")
	second, _ := s.send(token, general, "while away 2", "resume-nonce-2")
	conn = s.connect(token, start)
	if hello := read(t, conn); hello.Op != "hello" || hello.LastEventID != start {
		t.Fatalf("resume hello = %+v", hello)
	}
	var m1, m2 message
	e1, e2 := read(t, conn), read(t, conn)
	_ = json.Unmarshal(e1.Data, &m1)
	_ = json.Unmarshal(e2.Data, &m2)
	if m1.ID != first.ID || m2.ID != second.ID {
		t.Fatalf("resumed %s, %s; want %s, %s", m1.ID, m2.ID, first.ID, second.ID)
	}
	// Then live events continue without duplicates.
	third, _ := s.send(token, general, "live", "resume-nonce-3")
	var m3 message
	_ = json.Unmarshal(read(t, conn).Data, &m3)
	if m3.ID != third.ID {
		t.Fatalf("live after resume = %s, want %s", m3.ID, third.ID)
	}

	// An unknown position cannot be resumed: hello at the tip, then resync.
	for _, bogus := range []string{"not-an-id", "99999999999999-0"} {
		c := s.connect(token, bogus)
		if hello := read(t, c); hello.Op != "hello" || hello.LastEventID == bogus {
			t.Errorf("%s: hello = %+v", bogus, hello)
		}
		if f := read(t, c); f.Op != "resync" {
			t.Errorf("%s: got %+v, want resync", bogus, f)
		}
	}
}

func TestResumeAfterTrimmingResyncs(t *testing.T) {
	sh := newShared(t)
	s := newStack(t, sh, options{settings: realtime.Settings{
		Heartbeat: time.Second, SessionCheck: time.Second, QueueSize: 64, MaxBacklog: 3,
	}})
	token := s.user("sub-a", "Ayşe")
	general := s.general(token)
	conn := s.connect(token, "")
	start := read(t, conn).LastEventID
	_ = conn.Close(websocket.StatusNormalClosure, "")
	for i := range 5 { // more than MaxBacklog
		s.send(token, general, "x", "trim-nonce-"+string(rune('a'+i)))
	}
	conn = s.connect(token, start)
	read(t, conn)
	if f := read(t, conn); f.Op != "resync" {
		t.Errorf("got %+v, want resync", f)
	}
}

func TestTickets(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	token := s.user("sub-a", "Ayşe")

	ticket := s.ticket(token)
	c, _, err := s.dial(ticket, "")
	if err != nil {
		t.Fatal(err)
	}
	read(t, c)
	_ = c.Close(websocket.StatusNormalClosure, "")

	// A ticket works once.
	c, _, err = s.dial(ticket, "")
	if err != nil {
		t.Fatal(err)
	}
	if code := closeStatus(t, c); code != realtime.CloseInvalidTicket {
		t.Errorf("reused ticket: close %d", code)
	}
	if res := s.call(http.MethodPost, "/api/ws/ticket", "", nil, nil); res.StatusCode != http.StatusUnauthorized {
		t.Errorf("ticket without session = %d", res.StatusCode)
	}

	// Other origins cannot open the socket (cross-site WebSocket hijacking).
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, res, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(s.srv.URL, "http")+"/ws?ticket="+s.ticket(token),
		&websocket.DialOptions{HTTPHeader: http.Header{"Origin": {"https://evil.example"}}})
	if err == nil || res == nil || res.StatusCode != http.StatusForbidden {
		t.Errorf("foreign origin: err=%v res=%v", err, res)
	}
}

func TestSessionEndClosesConnection(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	token := s.user("sub-a", "Ayşe")
	conn := s.connect(token, "")
	read(t, conn)
	if res := s.call(http.MethodPost, "/api/auth/logout", token, nil, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("logout = %d", res.StatusCode)
	}
	if code := closeStatus(t, conn); code != realtime.CloseSessionEnded {
		t.Errorf("close %d, want %d", code, realtime.CloseSessionEnded)
	}
}

// The HTTP server's write timeout must not cut long-lived connections.
func TestConnectionOutlivesHTTPTimeouts(t *testing.T) {
	s := newStack(t, newShared(t), options{httpTimeout: 300 * time.Millisecond})
	token := s.user("sub-a", "Ayşe")
	general := s.general(token)
	conn := s.connect(token, "")
	read(t, conn)
	time.Sleep(1200 * time.Millisecond) // several heartbeats and timeouts
	sent, _ := s.send(token, general, "still here", "timeout-nonce-1")
	var got message
	_ = json.Unmarshal(read(t, conn).Data, &got)
	if got.ID != sent.ID {
		t.Fatalf("got %s, want %s", got.ID, sent.ID)
	}
}

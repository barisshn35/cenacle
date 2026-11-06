// SPDX-License-Identifier: AGPL-3.0-only

package auth_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Cenacle-TR/cenacle/server/internal/app"
	"github.com/Cenacle-TR/cenacle/server/internal/auth"
	"github.com/Cenacle-TR/cenacle/server/internal/cache"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
	"github.com/Cenacle-TR/cenacle/server/internal/testdb"
)

// memFlows is an in-memory FlowStore with take-once semantics.
type memFlows struct {
	mu sync.Mutex
	m  map[string][]byte
}

func (s *memFlows) PutNew(_ context.Context, key string, value []byte, _ time.Duration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.m[key]; ok {
		return errors.New("exists")
	}
	s.m[key] = value
	return nil
}

func (s *memFlows) Take(_ context.Context, key string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.m[key]
	if !ok {
		return nil, cache.ErrNotFound
	}
	delete(s.m, key)
	return v, nil
}

type env struct {
	t        *testing.T
	idp      *fakeIdP
	app      *httptest.Server
	pool     *pgxpool.Pool
	sessions *auth.Sessions
	client   *http.Client
	webApp   *auth.WebApp
	handlers *auth.Handlers
}

func newEnv(t *testing.T) *env {
	t.Helper()
	pool := testdb.Open(t)
	idp := newFakeIdP(t)
	queries := store.New(pool)
	sessions := &auth.Sessions{Queries: queries, IdleTimeout: time.Hour, MaxAge: 24 * time.Hour}

	e := &env{t: t, idp: idp, pool: pool, sessions: sessions, webApp: &auth.WebApp{Store: queries}}
	handlers := &auth.Handlers{
		WebApp:     e.webApp,
		Sessions:   sessions,
		Users:      queries,
		Flows:      &memFlows{m: map[string][]byte{}},
		AdminEmail: "AYSE@example.com", // compared without case
		Log:        slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	// The router needs the public URL, known once the server listens.
	var router http.Handler
	e.app = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		router.ServeHTTP(w, r)
	}))
	t.Cleanup(e.app.Close)
	public, _ := url.Parse(e.app.URL)
	handlers.PublicURL = public
	handlers.Cookies = auth.NewCookies(public)
	handlers.IdP = &auth.IdentityProvider{
		Issuer:       idp.Issuer(),
		ClientID:     testClientID,
		ClientSecret: testClientSecret,
		RedirectURL:  e.app.URL + "/api/auth/callback",
		HTTPClient:   http.DefaultClient,
	}
	router = app.NewRouter(app.Deps{Log: handlers.Log, Auth: handlers})
	e.client = newClient(t)
	e.handlers = handlers
	return e
}

func newClient(t *testing.T) *http.Client {
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	return &http.Client{
		Jar: jar,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// signIn follows the redirects of a sign-in starting at path and returns the
// final location inside the app.
func (e *env) signIn(c *http.Client, path string) *url.URL {
	e.t.Helper()
	next := e.app.URL + path
	for range 5 {
		res, err := c.Get(next)
		if err != nil {
			e.t.Fatal(err)
		}
		_ = res.Body.Close()
		if res.StatusCode != http.StatusFound {
			e.t.Fatalf("GET %s: status %d", next, res.StatusCode)
		}
		loc, err := res.Location()
		if err != nil {
			e.t.Fatal(err)
		}
		if strings.HasPrefix(loc.String(), e.app.URL) && !strings.HasPrefix(loc.Path, "/api/") {
			return loc
		}
		next = loc.String()
	}
	e.t.Fatal("too many redirects")
	return nil
}

func (e *env) do(c *http.Client, method, path string, header http.Header) (*http.Response, []byte) {
	e.t.Helper()
	req, _ := http.NewRequest(method, e.app.URL+path, nil)
	for k, v := range header {
		req.Header[k] = v
	}
	res, err := c.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	body, _ := io.ReadAll(res.Body)
	return res, body
}

func (e *env) sessionCookie(c *http.Client) *http.Cookie {
	u, _ := url.Parse(e.app.URL)
	for _, ck := range c.Jar.Cookies(u) {
		if ck.Name == "cenacle_session" {
			return ck
		}
	}
	return nil
}

func TestSignInCreatesUserAndSession(t *testing.T) {
	e := newEnv(t)

	loc := e.signIn(e.client, "/api/auth/login?return_to="+url.QueryEscape("/c/general?x=1"))
	if loc.Path != "/c/general" || loc.RawQuery != "x=1" {
		t.Fatalf("landed at %s, want /c/general?x=1", loc)
	}
	auth := e.idp.LastAuth
	if auth.Get("code_challenge_method") != "S256" || auth.Get("code_challenge") == "" ||
		auth.Get("nonce") == "" || auth.Get("response_type") != "code" ||
		auth.Get("scope") != "openid email profile groups" {
		t.Errorf("authorization request = %v", auth)
	}

	res, body := e.do(e.client, http.MethodGet, "/api/session", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/session = %d %s", res.StatusCode, body)
	}
	var s struct {
		User struct {
			ID          string `json:"id"`
			Email       string `json:"email"`
			DisplayName string `json:"display_name"`
		} `json:"user"`
		IdleTimeoutSeconds int `json:"idle_timeout_seconds"`
	}
	if err := json.Unmarshal(body, &s); err != nil {
		t.Fatal(err)
	}
	if s.User.Email != "ayse@example.com" || s.User.DisplayName != "Ayşe Yılmaz" || s.IdleTimeoutSeconds != 3600 {
		t.Errorf("session = %+v", s)
	}
	if got := res.Header.Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q", got)
	}

	// A second sign-in of the same subject reuses the user and refreshes the profile.
	e.idp.Name = "Ayşe Y."
	other := newClient(t)
	e.signIn(other, "/api/auth/login")
	var users, sessions int
	var name string
	_ = e.pool.QueryRow(context.Background(), "SELECT count(*), min(display_name) FROM users").Scan(&users, &name)
	_ = e.pool.QueryRow(context.Background(), "SELECT count(*) FROM sessions").Scan(&sessions)
	if users != 1 || name != "Ayşe Y." || sessions != 2 {
		t.Errorf("users=%d name=%q sessions=%d, want 1, Ayşe Y., 2", users, name, sessions)
	}
}

func TestSessionCookieAttributes(t *testing.T) {
	e := newEnv(t)
	res, _ := e.do(e.client, http.MethodGet, "/api/auth/login", nil)
	loc, _ := res.Location()
	// Follow IdP, then inspect the raw Set-Cookie of the callback.
	res2, err := e.client.Get(loc.String())
	if err != nil {
		t.Fatal(err)
	}
	_ = res2.Body.Close()
	cb, _ := res2.Location()
	res3, err := e.client.Get(cb.String())
	if err != nil {
		t.Fatal(err)
	}
	_ = res3.Body.Close()
	var session string
	for _, sc := range res3.Header.Values("Set-Cookie") {
		if strings.HasPrefix(sc, "cenacle_session=") {
			session = sc
		}
	}
	for _, want := range []string{"HttpOnly", "SameSite=Lax", "Path=/", "Max-Age="} {
		if !strings.Contains(session, want) {
			t.Errorf("session cookie %q lacks %s", session, want)
		}
	}
	if strings.Contains(session, "Domain=") {
		t.Errorf("session cookie must be host-only: %q", session)
	}
	var stored []byte
	_ = e.pool.QueryRow(context.Background(), "SELECT token_hash FROM sessions").Scan(&stored)
	if ck := e.sessionCookie(e.client); ck == nil || strings.Contains(string(stored), ck.Value) {
		t.Error("the token must be stored only as a hash")
	}
}

func TestReturnToStaysInsideTheApp(t *testing.T) {
	for _, target := range []string{"//evil.example/x", "https://evil.example", `/\evil.example`, "c/general"} {
		e := newEnv(t)
		loc := e.signIn(e.client, "/api/auth/login?return_to="+url.QueryEscape(target))
		if loc.String() != e.app.URL+"/" {
			t.Errorf("return_to=%q landed at %s", target, loc)
		}
	}
}

func signinError(t *testing.T, loc *url.URL) string {
	t.Helper()
	if loc.Path != "/signin" {
		t.Fatalf("landed at %s, want /signin", loc)
	}
	return loc.Query().Get("error")
}

func TestCallbackFailures(t *testing.T) {
	t.Run("cancelled at the IdP keeps return_to", func(t *testing.T) {
		e := newEnv(t)
		e.idp.AuthError = "access_denied"
		loc := e.signIn(e.client, "/api/auth/login?return_to=/c/x")
		if got := signinError(t, loc); got != "cancelled" || loc.Query().Get("return_to") != "/c/x" {
			t.Errorf("landed at %s", loc)
		}
	})
	t.Run("nonce mismatch", func(t *testing.T) {
		e := newEnv(t)
		e.idp.WrongNonce = "other"
		if got := signinError(t, e.signIn(e.client, "/api/auth/login")); got != "failed" {
			t.Errorf("error = %q", got)
		}
	})
	t.Run("response from another issuer", func(t *testing.T) {
		e := newEnv(t)
		e.idp.WrongIss = "https://evil.example"
		if got := signinError(t, e.signIn(e.client, "/api/auth/login")); got != "failed" {
			t.Errorf("error = %q", got)
		}
	})
	t.Run("userinfo of another subject", func(t *testing.T) {
		e := newEnv(t)
		e.idp.UserinfoSubject = "sub-2"
		if got := signinError(t, e.signIn(e.client, "/api/auth/login")); got != "failed" {
			t.Errorf("error = %q", got)
		}
	})
	t.Run("callback in another browser (login CSRF)", func(t *testing.T) {
		e := newEnv(t)
		res, _ := e.do(e.client, http.MethodGet, "/api/auth/login", nil)
		authURL, _ := res.Location()
		res, err := e.client.Get(authURL.String())
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
		callback, _ := res.Location()
		victim := newClient(t)
		res, err = victim.Get(callback.String())
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
		loc, _ := res.Location()
		if got := signinError(t, loc); got != "expired" {
			t.Errorf("error = %q", got)
		}
		if e.sessionCookie(victim) != nil {
			t.Error("victim got a session")
		}
	})
	t.Run("replayed callback", func(t *testing.T) {
		e := newEnv(t)
		res, _ := e.do(e.client, http.MethodGet, "/api/auth/login", nil)
		authURL, _ := res.Location()
		res, err := e.client.Get(authURL.String())
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
		callback, _ := res.Location()
		state := e.client.Jar.Cookies(callback)
		for range 2 {
			e.client.Jar.SetCookies(callback, state) // the browser kept the flow cookie
			res, err = e.client.Get(callback.String())
			if err != nil {
				t.Fatal(err)
			}
			_ = res.Body.Close()
		}
		loc, _ := res.Location()
		if got := signinError(t, loc); got != "expired" {
			t.Errorf("second use: error = %q", got)
		}
	})
	t.Run("identity provider unreachable", func(t *testing.T) {
		e := newEnv(t)
		e.idp.srv.Close()
		res, _ := e.do(e.client, http.MethodGet, "/api/auth/login?return_to=/c/x", nil)
		loc, _ := res.Location()
		if got := signinError(t, loc); got != "unavailable" || loc.Query().Get("return_to") != "/c/x" {
			t.Errorf("landed at %s", loc)
		}
	})
}

func TestLogout(t *testing.T) {
	e := newEnv(t)
	e.signIn(e.client, "/api/auth/login")
	origin := http.Header{"Origin": {e.app.URL}}

	res, body := e.do(e.client, http.MethodPost, "/api/auth/logout", http.Header{"Origin": {"https://evil.example"}})
	if res.StatusCode != http.StatusForbidden || !strings.Contains(string(body), `"code":"cross_site_request"`) {
		t.Fatalf("cross-site logout = %d %s", res.StatusCode, body)
	}
	if res, _ := e.do(e.client, http.MethodPost, "/api/auth/logout", nil); res.StatusCode != http.StatusForbidden {
		t.Fatalf("logout without Origin or Sec-Fetch-Site = %d", res.StatusCode)
	}

	res, body = e.do(e.client, http.MethodPost, "/api/auth/logout", origin)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("logout = %d %s", res.StatusCode, body)
	}
	var out struct {
		EndSessionURL string `json:"end_session_url"`
	}
	_ = json.Unmarshal(body, &out)
	end, _ := url.Parse(out.EndSessionURL)
	if end.Path != "/session/end" || end.Query().Get("client_id") != testClientID ||
		end.Query().Get("post_logout_redirect_uri") != e.app.URL+"/" {
		t.Errorf("end_session_url = %q", out.EndSessionURL)
	}
	if e.sessionCookie(e.client) != nil {
		t.Error("session cookie not cleared")
	}
	var n int
	_ = e.pool.QueryRow(context.Background(), "SELECT count(*) FROM sessions").Scan(&n)
	if n != 0 {
		t.Errorf("%d sessions left", n)
	}
	// Logging out again is harmless.
	if res, _ := e.do(e.client, http.MethodPost, "/api/auth/logout", http.Header{"Sec-Fetch-Site": {"same-origin"}}); res.StatusCode != http.StatusOK {
		t.Errorf("second logout = %d", res.StatusCode)
	}
}

func TestUnauthenticated(t *testing.T) {
	e := newEnv(t)
	e.client.Jar.SetCookies(mustURL(e.app.URL), []*http.Cookie{{Name: "cenacle_session", Value: strings.Repeat("A", 43)}})
	res, body := e.do(e.client, http.MethodGet, "/api/session", nil)
	if res.StatusCode != http.StatusUnauthorized || !strings.Contains(string(body), `"code":"unauthenticated"`) {
		t.Fatalf("GET /api/session = %d %s", res.StatusCode, body)
	}
	if res.Header.Get("Content-Type") != "application/problem+json" || res.Header.Get("WWW-Authenticate") == "" {
		t.Errorf("headers = %v", res.Header)
	}
	if e.sessionCookie(e.client) != nil {
		t.Error("an unknown session cookie is cleared")
	}
}

func mustURL(s string) *url.URL {
	u, err := url.Parse(s)
	if err != nil {
		panic(err)
	}
	return u
}

func TestBearerToken(t *testing.T) {
	e := newEnv(t)
	e.signIn(e.client, "/api/auth/login")
	token := e.sessionCookie(e.client).Value

	bare := &http.Client{}
	bearer := http.Header{"Authorization": {"Bearer " + token}}
	if res, body := e.do(bare, http.MethodGet, "/api/session", bearer); res.StatusCode != http.StatusOK {
		t.Fatalf("bearer GET /api/session = %d %s", res.StatusCode, body)
	}
	// Bearer requests are not exposed to CSRF: no Origin needed.
	if res, body := e.do(bare, http.MethodPost, "/api/auth/logout", bearer); res.StatusCode != http.StatusOK {
		t.Fatalf("bearer logout = %d %s", res.StatusCode, body)
	}
	if res, _ := e.do(bare, http.MethodGet, "/api/session", bearer); res.StatusCode != http.StatusUnauthorized {
		t.Errorf("token still valid after logout: %d", res.StatusCode)
	}
}

func TestSessionExpiry(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t)
	e.signIn(e.client, "/api/auth/login")

	if _, err := e.pool.Exec(ctx, "UPDATE sessions SET last_seen_at = now() - interval '2 hours'"); err != nil {
		t.Fatal(err)
	}
	if res, _ := e.do(e.client, http.MethodGet, "/api/session", nil); res.StatusCode != http.StatusUnauthorized {
		t.Errorf("idle session = %d, want 401", res.StatusCode)
	}

	e.signIn(e.client, "/api/auth/login")
	if _, err := e.pool.Exec(ctx, "UPDATE sessions SET expires_at = now() - interval '1 second' WHERE last_seen_at > now() - interval '1 minute'"); err != nil {
		t.Fatal(err)
	}
	if res, _ := e.do(e.client, http.MethodGet, "/api/session", nil); res.StatusCode != http.StatusUnauthorized {
		t.Errorf("expired session = %d, want 401", res.StatusCode)
	}

	n, err := e.sessions.DeleteExpired(ctx)
	if err != nil || n != 2 {
		t.Errorf("DeleteExpired = %d, %v; want 2", n, err)
	}
}

func TestSessionUseIsRecorded(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t)
	e.signIn(e.client, "/api/auth/login")
	if _, err := e.pool.Exec(ctx, "UPDATE sessions SET last_seen_at = now() - interval '10 minutes'"); err != nil {
		t.Fatal(err)
	}
	e.do(e.client, http.MethodGet, "/api/session", http.Header{"User-Agent": {"Cenacle-Test/1"}})
	var age time.Duration
	var ua string
	_ = e.pool.QueryRow(ctx, "SELECT extract(epoch FROM now() - last_seen_at)::bigint * 1000000000, user_agent FROM sessions").Scan(&age, &ua)
	if age > time.Minute || ua != "Cenacle-Test/1" {
		t.Errorf("last_seen age=%v user_agent=%q", age, ua)
	}
}

func TestSignInAppliesAdministratorAndDefaultChannels(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t)
	permissions := func(c *http.Client) bool {
		var s struct {
			Permissions struct {
				CreateWorkspaces bool `json:"create_workspaces"`
			} `json:"permissions"`
		}
		_, body := e.do(c, http.MethodGet, "/api/session", nil)
		_ = json.Unmarshal(body, &s)
		return s.Permissions.CreateWorkspaces
	}

	// ayse@example.com (verified) is the configured administrator.
	e.signIn(e.client, "/api/auth/login")
	if !permissions(e.client) {
		t.Error("the configured administrator cannot create channels")
	}
	var defaults, memberships int
	_ = e.pool.QueryRow(ctx, "SELECT count(*) FROM channels WHERE is_default").Scan(&defaults)
	_ = e.pool.QueryRow(ctx, "SELECT count(*) FROM channel_members").Scan(&memberships)
	if defaults == 0 || memberships != defaults {
		t.Errorf("default channels %d, memberships %d", defaults, memberships)
	}

	// Another user is not.
	e.idp.Subject, e.idp.Email = "sub-2", "mert@example.com"
	other := newClient(t)
	e.signIn(other, "/api/auth/login")
	if permissions(other) {
		t.Error("another user can create channels")
	}

	// The address moves to the other user: the flag moves with the next sign-in.
	e.idp.Email = "ayse@example.com"
	e.signIn(newClient(t), "/api/auth/login")
	var admins []string
	rows, _ := e.pool.Query(ctx, "SELECT auth_data FROM users WHERE is_admin")
	for rows.Next() {
		var s string
		_ = rows.Scan(&s)
		admins = append(admins, s)
	}
	if len(admins) != 1 || admins[0] != "sub-2" {
		t.Errorf("administrators = %v, want [sub-2]", admins)
	}
}

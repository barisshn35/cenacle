// SPDX-License-Identifier: AGPL-3.0-only

package auth_test

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func (e *env) desktopToken(code, verifier string) (*http.Response, map[string]any) {
	e.t.Helper()
	body, _ := json.Marshal(map[string]string{"code": code, "verifier": verifier})
	res, err := http.Post(e.app.URL+"/api/auth/desktop/token", "application/json", strings.NewReader(string(body)))
	if err != nil {
		e.t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	raw, _ := io.ReadAll(res.Body)
	out := map[string]any{}
	_ = json.Unmarshal(raw, &out)
	return res, out
}

func TestDesktopSignIn(t *testing.T) {
	e := newEnv(t)
	verifier := strings.Repeat("v", 43) + "-desktop-verifier"
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])

	// The web app is off: the desktop app still signs in.
	off := false
	e.webApp.Forced = &off
	window := newClient(t)
	loc := e.signIn(window, "/api/auth/login?desktop="+challenge)
	if loc.Path != "/desktop/signed-in" || loc.Query().Get("code") == "" {
		t.Fatalf("desktop sign-in ended at %s", loc)
	}
	if e.sessionCookie(window) != nil {
		t.Error("the desktop window got a session cookie")
	}
	code := loc.Query().Get("code")

	// The wrong verifier uses the code up.
	if res, _ := e.desktopToken(code, strings.Repeat("x", 43)); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("wrong verifier = %d", res.StatusCode)
	}
	if res, _ := e.desktopToken(code, verifier); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("a used code was exchanged: %d", res.StatusCode)
	}

	// A fresh sign-in, exchanged right.
	loc = e.signIn(newClient(t), "/api/auth/login?desktop="+challenge)
	res, out := e.desktopToken(loc.Query().Get("code"), verifier)
	if res.StatusCode != http.StatusOK || out["token"] == nil || res.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("exchange = %d %v", res.StatusCode, out)
	}
	bearer := http.Header{"Authorization": {"Bearer " + out["token"].(string)}}
	if res, body := e.do(&http.Client{}, http.MethodGet, "/api/session", bearer); res.StatusCode != http.StatusOK {
		t.Fatalf("desktop session = %d %s", res.StatusCode, body)
	}
	// Browsers stay turned away.
	if got := signinError(t, e.signIn(newClient(t), "/api/auth/login")); got != "web_app_off" {
		t.Errorf("browser sign-in = %q", got)
	}
	// A malformed challenge is refused.
	if got := signinError(t, e.signIn(newClient(t), "/api/auth/login?desktop=short")); got != "failed" {
		t.Errorf("bad challenge = %q", got)
	}
}

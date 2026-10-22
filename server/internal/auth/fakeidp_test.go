// SPDX-License-Identifier: AGPL-3.0-only

package auth_test

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
)

const (
	testClientID     = "cenacle-chat"
	testClientSecret = "test-client-secret"
)

// fakeIdP is a minimal OpenID Provider: discovery, authorization (answers
// immediately as the configured user), token with PKCE, userinfo and JWKS.
type fakeIdP struct {
	t   *testing.T
	srv *httptest.Server
	key *rsa.PrivateKey

	mu sync.Mutex
	// Subject, Email and Name describe the signed-in user; SID is the IdP
	// session put into ID tokens ("" for none).
	Subject, Email, Name, SID string
	// AuthError makes /auth answer with this OAuth error instead of a code.
	AuthError string
	// Tamper hooks for negative tests.
	WrongNonce, WrongIss, UserinfoSubject string
	// LastAuth holds the query of the latest authorization request.
	LastAuth url.Values
	codes    map[string]url.Values
}

func newFakeIdP(t *testing.T) *fakeIdP {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeIdP{t: t, key: key, Subject: "sub-1", Email: "ayse@example.com", Name: "Ayşe Yılmaz",
		codes: map[string]url.Values{}}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /.well-known/openid-configuration", f.discovery)
	mux.HandleFunc("GET /auth", f.authorize)
	mux.HandleFunc("POST /token", f.token)
	mux.HandleFunc("GET /me", f.userinfo)
	mux.HandleFunc("GET /jwks", f.jwks)
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeIdP) Issuer() string { return f.srv.URL }

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func (f *fakeIdP) discovery(w http.ResponseWriter, _ *http.Request) {
	iss := f.Issuer()
	writeJSON(w, map[string]any{
		"issuer":                                iss,
		"authorization_endpoint":                iss + "/auth",
		"token_endpoint":                        iss + "/token",
		"userinfo_endpoint":                     iss + "/me",
		"jwks_uri":                              iss + "/jwks",
		"end_session_endpoint":                  iss + "/session/end",
		"id_token_signing_alg_values_supported": []string{"RS256"},
		"authorization_response_iss_parameter_supported": true,
	})
}

func (f *fakeIdP) authorize(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	q := r.URL.Query()
	f.LastAuth = q
	redirect, err := url.Parse(q.Get("redirect_uri"))
	if err != nil {
		http.Error(w, "bad redirect_uri", http.StatusBadRequest)
		return
	}
	iss := f.Issuer()
	if f.WrongIss != "" {
		iss = f.WrongIss
	}
	res := url.Values{"state": {q.Get("state")}, "iss": {iss}}
	if f.AuthError != "" {
		res.Set("error", f.AuthError)
	} else {
		code := randomCode()
		f.codes[code] = q
		res.Set("code", code)
	}
	redirect.RawQuery = res.Encode()
	http.Redirect(w, r, redirect.String(), http.StatusFound)
}

func randomCode() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func (f *fakeIdP) token(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	id, secret, ok := r.BasicAuth()
	if !ok || id != testClientID || secret != testClientSecret {
		w.WriteHeader(http.StatusUnauthorized)
		writeJSON(w, map[string]string{"error": "invalid_client"})
		return
	}
	_ = r.ParseForm()
	auth, ok := f.codes[r.PostForm.Get("code")]
	delete(f.codes, r.PostForm.Get("code"))
	sum := sha256.Sum256([]byte(r.PostForm.Get("code_verifier")))
	if !ok || r.PostForm.Get("grant_type") != "authorization_code" ||
		r.PostForm.Get("redirect_uri") != auth.Get("redirect_uri") ||
		auth.Get("code_challenge_method") != "S256" ||
		base64.RawURLEncoding.EncodeToString(sum[:]) != auth.Get("code_challenge") {
		w.WriteHeader(http.StatusBadRequest)
		writeJSON(w, map[string]string{"error": "invalid_grant"})
		return
	}
	nonce := auth.Get("nonce")
	if f.WrongNonce != "" {
		nonce = f.WrongNonce
	}
	claims := map[string]any{
		"iss": f.Issuer(), "sub": f.Subject, "aud": testClientID, "nonce": nonce,
		"iat": time.Now().Unix(), "exp": time.Now().Add(10 * time.Minute).Unix(),
	}
	if f.SID != "" {
		claims["sid"] = f.SID
	}
	idToken := f.sign(claims)
	writeJSON(w, map[string]any{
		"access_token": "at-" + f.Subject, "token_type": "Bearer", "expires_in": 600,
		"id_token": idToken, "scope": auth.Get("scope"),
	})
}

func (f *fakeIdP) userinfo(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.Header.Get("Authorization") != "Bearer at-"+f.Subject {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	sub := f.Subject
	if f.UserinfoSubject != "" {
		sub = f.UserinfoSubject
	}
	writeJSON(w, map[string]any{"sub": sub, "email": f.Email, "email_verified": true, "name": f.Name})
}

func (f *fakeIdP) jwks(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, jose.JSONWebKeySet{Keys: []jose.JSONWebKey{
		{Key: &f.key.PublicKey, KeyID: "k1", Algorithm: "RS256", Use: "sig"},
	}})
}

func (f *fakeIdP) sign(claims map[string]any) string {
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: f.key},
		(&jose.SignerOptions{}).WithType("JWT").WithHeader("kid", "k1"))
	if err != nil {
		f.t.Fatal(err)
	}
	raw, err := jwt.Signed(signer).Claims(claims).Serialize()
	if err != nil {
		f.t.Fatal(err)
	}
	return raw
}

// logoutToken is a logout token as Cenacle ID sends it; extra replaces or
// (with nil) removes claims.
func (f *fakeIdP) logoutToken(sub, sid string, extra map[string]any) string {
	claims := map[string]any{
		"iss": f.Issuer(), "aud": testClientID, "sub": sub, "sid": sid, "jti": randomCode(),
		"iat": time.Now().Unix(), "exp": time.Now().Add(2 * time.Minute).Unix(),
		"events": map[string]any{"http://schemas.openid.net/event/backchannel-logout": map[string]any{}},
	}
	if sid == "" {
		delete(claims, "sid")
	}
	for k, v := range extra {
		if v == nil {
			delete(claims, k)
		} else {
			claims[k] = v
		}
	}
	return f.sign(claims)
}

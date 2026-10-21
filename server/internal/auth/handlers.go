// SPDX-License-Identifier: Apache-2.0

package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/httpx"
	"github.com/barisshn35/cenacle/server/internal/store"
)

// AuthService is the value of users.auth_service for Cenacle ID accounts.
const AuthService = "cenacle-id"

// flowTTL bounds how long a user may take on the sign-in pages of Cenacle ID
// (its interaction lifetime is 15 minutes).
const flowTTL = 15 * time.Minute

// Error codes passed to the web app in /signin?error=..., mapped to localized text there.
const (
	signinCancelled   = "cancelled"   // the user cancelled at Cenacle ID
	signinExpired     = "expired"     // the flow is unknown, used or too old
	signinFailed      = "failed"      // the IdP response did not verify
	signinUnavailable = "unavailable" // Cenacle ID or the database is unreachable
)

// FlowStore keeps the state of sign-ins in progress. Take must return a value
// at most once (Valkey GETDEL).
type FlowStore interface {
	PutNew(ctx context.Context, key string, value []byte, ttl time.Duration) error
	Take(ctx context.Context, key string) ([]byte, error)
}

// flow is what the server remembers between the redirect to the IdP and the callback.
type flow struct {
	Verifier string `json:"verifier"`
	Nonce    string `json:"nonce"`
	ReturnTo string `json:"return_to"`
}

// Handlers implements the auth operations of the API.
type Handlers struct {
	IdP      *IdentityProvider
	Sessions *Sessions
	Users    store.Querier
	Flows    FlowStore
	Cookies  Cookies
	// PublicURL is the origin of the web app.
	PublicURL *url.URL
	// TrustProxy takes the client address from X-Forwarded-For.
	TrustProxy bool
	// AdminEmail is the verified address of the administrator ("" for none).
	AdminEmail string
	Log        *slog.Logger
}

func randomString() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func flowKey(state string) string { return "cenacle:auth:flow:" + state }

// Login implements api.ServerInterface.
func (h *Handlers) Login(w http.ResponseWriter, r *http.Request, params api.LoginParams) {
	returnTo := "/"
	if params.ReturnTo != nil {
		returnTo = SafeReturnPath(*params.ReturnTo)
	}
	provider, _, err := h.IdP.discover(r.Context())
	if err != nil {
		h.Log.ErrorContext(r.Context(), "sign-in unavailable", "error", err,
			"request_id", httpx.RequestIDFrom(r.Context()))
		h.redirectSigninError(w, r, signinUnavailable, returnTo)
		return
	}

	state := randomString()
	f := flow{Verifier: oauth2.GenerateVerifier(), Nonce: randomString(), ReturnTo: returnTo}
	value, _ := json.Marshal(f)
	if err := h.Flows.PutNew(r.Context(), flowKey(state), value, flowTTL); err != nil {
		h.Log.ErrorContext(r.Context(), "store sign-in flow", "error", err,
			"request_id", httpx.RequestIDFrom(r.Context()))
		h.redirectSigninError(w, r, signinUnavailable, returnTo)
		return
	}
	// The state is also bound to this browser, so a callback URL cannot be
	// replayed in someone else's browser (login CSRF).
	h.Cookies.setFlow(w, state, flowTTL)

	target := h.IdP.oauth2Config(provider).AuthCodeURL(state,
		oauth2.S256ChallengeOption(f.Verifier), oidc.Nonce(f.Nonce))
	http.Redirect(w, r, target, http.StatusFound)
}

// AuthCallback implements api.ServerInterface.
func (h *Handlers) AuthCallback(w http.ResponseWriter, r *http.Request, params api.AuthCallbackParams) {
	ctx := r.Context()
	log := h.Log.With("request_id", httpx.RequestIDFrom(ctx))
	state := deref(params.State)
	cookieState := h.Cookies.flow(r)
	h.Cookies.clearFlow(w)

	if state == "" || cookieState == "" ||
		subtle.ConstantTimeCompare([]byte(state), []byte(cookieState)) != 1 {
		log.InfoContext(ctx, "sign-in callback without matching state")
		h.redirectSigninError(w, r, signinExpired, "/")
		return
	}
	raw, err := h.Flows.Take(ctx, flowKey(state))
	if err != nil {
		log.InfoContext(ctx, "sign-in flow not found", "error", err)
		h.redirectSigninError(w, r, signinExpired, "/")
		return
	}
	var f flow
	if err := json.Unmarshal(raw, &f); err != nil {
		log.ErrorContext(ctx, "decode sign-in flow", "error", err)
		h.redirectSigninError(w, r, signinFailed, "/")
		return
	}

	if e := deref(params.Error); e != "" {
		code := signinFailed
		if e == "access_denied" {
			code = signinCancelled
		}
		log.InfoContext(ctx, "sign-in ended at the identity provider", "error", e,
			"error_description", deref(params.ErrorDescription))
		h.redirectSigninError(w, r, code, f.ReturnTo)
		return
	}

	principal, err := h.finishSignIn(ctx, params, f, h.clientInfo(r))
	if err != nil {
		code := signinFailed
		var unavailable errUnavailable
		if errors.As(err, &unavailable) {
			code = signinUnavailable
		}
		log.WarnContext(ctx, "sign-in failed", "error", err)
		h.redirectSigninError(w, r, code, f.ReturnTo)
		return
	}
	h.Cookies.setSession(w, principal.token, principal.session.ExpiresAt)
	log.InfoContext(ctx, "signed in", "user_id", principal.session.UserID)
	http.Redirect(w, r, h.PublicURL.String()+f.ReturnTo, http.StatusFound)
}

// errUnavailable marks failures of a dependency rather than of the response.
type errUnavailable struct{ error }

func (e errUnavailable) Unwrap() error { return e.error }

type signedIn struct {
	token   string
	session store.Session
}

func (h *Handlers) finishSignIn(ctx context.Context, params api.AuthCallbackParams, f flow, client ClientInfo) (signedIn, error) {
	provider, meta, err := h.IdP.discover(ctx)
	if err != nil {
		return signedIn{}, errUnavailable{err}
	}
	// RFC 9207: the response must name the issuer we started with (mix-up defense).
	iss := deref(params.Iss)
	if (meta.AuthorizationResponseIss || iss != "") && iss != h.IdP.Issuer {
		return signedIn{}, errors.New("authorization response from another issuer")
	}
	code := deref(params.Code)
	if code == "" {
		return signedIn{}, errors.New("authorization response without code")
	}

	octx := h.IdP.clientContext(ctx)
	token, err := h.IdP.oauth2Config(provider).Exchange(octx, code, oauth2.VerifierOption(f.Verifier))
	if err != nil {
		var re *oauth2.RetrieveError
		if errors.As(err, &re) {
			return signedIn{}, err // rejected by the IdP
		}
		return signedIn{}, errUnavailable{err}
	}
	rawID, _ := token.Extra("id_token").(string)
	if rawID == "" {
		return signedIn{}, errors.New("token response without id_token")
	}
	idToken, err := provider.Verifier(&oidc.Config{ClientID: h.IdP.ClientID}).Verify(octx, rawID)
	if err != nil {
		return signedIn{}, err
	}
	if subtle.ConstantTimeCompare([]byte(idToken.Nonce), []byte(f.Nonce)) != 1 {
		return signedIn{}, errors.New("id token nonce mismatch")
	}

	info, err := provider.UserInfo(octx, oauth2.StaticTokenSource(token))
	if err != nil {
		return signedIn{}, errUnavailable{err}
	}
	if info.Subject != idToken.Subject {
		return signedIn{}, errors.New("userinfo subject differs from id token")
	}
	var profile struct {
		Name string `json:"name"`
	}
	if err := info.Claims(&profile); err != nil {
		return signedIn{}, err
	}

	user, err := h.Users.UpsertUserFromIdentity(ctx, store.UpsertUserFromIdentityParams{
		AuthService:   AuthService,
		AuthData:      idToken.Subject,
		Email:         info.Email,
		EmailVerified: info.EmailVerified,
		DisplayName:   profile.Name,
	})
	if err != nil {
		return signedIn{}, errUnavailable{err}
	}
	if err := h.applyRoles(ctx, user); err != nil {
		return signedIn{}, errUnavailable{err}
	}
	sessionToken, session, err := h.Sessions.Create(ctx, user.ID, client)
	if err != nil {
		return signedIn{}, errUnavailable{err}
	}
	return signedIn{token: sessionToken, session: session}, nil
}

// applyRoles makes a signed-in user a member of the default workspace and of
// the default channels of their workspaces, and gives or takes the instance
// administrator flag according to the configured address (only a verified
// address counts; there is at most one). The administrator owns the default
// workspace.
func (h *Handlers) applyRoles(ctx context.Context, user store.User) error {
	if _, err := h.Users.JoinDefaultWorkspace(ctx, user.ID); err != nil {
		return err
	}
	if _, err := h.Users.JoinDefaultChannels(ctx, user.ID); err != nil {
		return err
	}
	admin := h.AdminEmail != "" && user.EmailVerified && strings.EqualFold(user.Email, h.AdminEmail)
	if admin != user.IsAdmin {
		if admin {
			if err := h.Users.ClearAdminExcept(ctx, user.ID); err != nil {
				return err
			}
		}
		if err := h.Users.SetAdmin(ctx, store.SetAdminParams{ID: user.ID, IsAdmin: admin}); err != nil {
			return err
		}
	}
	if !admin {
		return nil
	}
	def, err := h.Users.GetDefaultWorkspace(ctx)
	if err != nil {
		return err
	}
	_, err = h.Users.SetWorkspaceRole(ctx, store.SetWorkspaceRoleParams{
		WorkspaceID: def.ID, UserID: user.ID, Role: "owner",
	})
	return err
}

// Logout implements api.ServerInterface. It succeeds without a session too,
// so a client can always clear its state.
func (h *Handlers) Logout(w http.ResponseWriter, r *http.Request) {
	if p, ok := PrincipalFrom(r.Context()); ok {
		if err := h.Sessions.Delete(r.Context(), p.Session.ID); err != nil {
			h.Log.ErrorContext(r.Context(), "delete session", "error", err,
				"request_id", httpx.RequestIDFrom(r.Context()))
			httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusServiceUnavailable, Code: httpx.CodeUnavailable})
			return
		}
	}
	h.Cookies.clearSession(w)
	httpx.WriteJSON(w, http.StatusOK, api.Logout{
		EndSessionUrl: h.IdP.EndSessionURL(h.PublicURL.String() + "/"),
	})
}

// GetSession implements api.ServerInterface.
func (h *Handlers) GetSession(w http.ResponseWriter, r *http.Request) {
	p, ok := RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	httpx.WriteJSON(w, http.StatusOK, api.Session{
		User: api.User{
			Id:            p.User.ID.Bytes,
			Email:         p.User.Email,
			EmailVerified: p.User.EmailVerified,
			DisplayName:   p.User.DisplayName,
		},
		Permissions:        api.Permissions{CreateWorkspaces: p.User.IsAdmin},
		CreatedAt:          p.Session.CreatedAt,
		ExpiresAt:          p.Session.ExpiresAt,
		IdleTimeoutSeconds: int(h.Sessions.IdleTimeout / time.Second),
	})
}

func (h *Handlers) redirectSigninError(w http.ResponseWriter, r *http.Request, code, returnTo string) {
	q := url.Values{"error": {code}}
	if returnTo != "/" {
		q.Set("return_to", returnTo)
	}
	http.Redirect(w, r, h.PublicURL.String()+"/signin?"+q.Encode(), http.StatusFound)
}

func (h *Handlers) clientInfo(r *http.Request) ClientInfo {
	return ClientInfo{UserAgent: r.UserAgent(), IP: ClientIP(r, h.TrustProxy)}
}

// SafeReturnPath returns p if it is a path inside the app, otherwise "/".
// It rejects absolute and scheme-relative URLs ("//evil.example",
// "/\evil.example"), which browsers would treat as another origin.
func SafeReturnPath(p string) string {
	if len(p) > 2048 || !strings.HasPrefix(p, "/") || strings.HasPrefix(p, "//") ||
		strings.ContainsAny(p, "\\\x00\r\n\t") {
		return "/"
	}
	u, err := url.Parse(p)
	if err != nil || u.Scheme != "" || u.Host != "" || u.User != nil {
		return "/"
	}
	return p
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

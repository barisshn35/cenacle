// SPDX-License-Identifier: AGPL-3.0-only

package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/audit"
	"github.com/barisshn35/cenacle/server/internal/events"
	"github.com/barisshn35/cenacle/server/internal/httpx"
	"github.com/barisshn35/cenacle/server/internal/store"
)

// accountURL is Cenacle ID's account page, returning to the web app.
func (h *Handlers) accountURL() string { return AccountURL(h.IdP.Issuer, h.PublicURL.String()) }

// AccountURL is Cenacle ID's account page with a way back to the app.
func AccountURL(issuer, app string) string {
	return issuer + "/account?return_to=" + url.QueryEscape(app+"/")
}

func (h *Handlers) unavailable(w http.ResponseWriter, r *http.Request, msg string, err error) {
	h.Log.ErrorContext(r.Context(), msg, "error", err, "request_id", httpx.RequestIDFrom(r.Context()))
	httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusServiceUnavailable, Code: httpx.CodeUnavailable})
}

// sessionsEnded makes the user's open connections check their session now
// instead of at the next periodic check.
func (h *Handlers) sessionsEnded(ctx context.Context, user pgtype.UUID) {
	if h.Ephemeral == nil {
		return
	}
	if err := h.Ephemeral.Publish(ctx, events.SessionsEnded, map[string]string{
		"user_id": openapi_types.UUID(user.Bytes).String(),
	}); err != nil {
		h.Log.WarnContext(ctx, "publish sessions ended", "error", err)
	}
}

// ListSessions implements api.ServerInterface.
func (h *Handlers) ListSessions(w http.ResponseWriter, r *http.Request) {
	p, ok := RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	rows, err := h.Users.ListUserSessions(r.Context(), store.ListUserSessionsParams{
		UserID: p.User.ID, IdleTimeout: interval(h.Sessions.IdleTimeout),
	})
	if err != nil {
		h.unavailable(w, r, "list sessions", err)
		return
	}
	out := make([]api.DeviceSession, 0, len(rows))
	for _, s := range rows {
		out = append(out, api.DeviceSession{
			Id: s.ID.Bytes, CreatedAt: s.CreatedAt, LastSeenAt: s.LastSeenAt,
			UserAgent: s.UserAgent, IpAddress: s.IpAddress, Current: s.ID == p.Session.ID,
		})
	}
	httpx.WriteJSON(w, http.StatusOK, struct {
		Sessions []api.DeviceSession `json:"sessions"`
	}{out})
}

// EndSession implements api.ServerInterface. Ending the current session also
// clears its cookie.
func (h *Handlers) EndSession(w http.ResponseWriter, r *http.Request, sessionID openapi_types.UUID) {
	p, ok := RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	id := pgtype.UUID{Bytes: sessionID, Valid: true}
	n, err := h.Users.DeleteUserSession(r.Context(), store.DeleteUserSessionParams{ID: id, UserID: p.User.ID})
	if err != nil {
		h.unavailable(w, r, "end session", err)
		return
	}
	if n == 0 {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound,
			Detail: "No session with this id."})
		return
	}
	h.Audit.Record(r.Context(), audit.Event{
		Actor: p.User.ID, Action: audit.SessionEnded, TargetType: "session", TargetID: sessionID.String(), IP: p.IP,
	})
	h.sessionsEnded(r.Context(), p.User.ID)
	if id == p.Session.ID {
		h.Cookies.clearSession(w)
	}
	w.WriteHeader(http.StatusNoContent)
}

// EndAllSessions implements api.ServerInterface.
func (h *Handlers) EndAllSessions(w http.ResponseWriter, r *http.Request) {
	p, ok := RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in struct {
		KeepCurrent *bool `json:"keep_current"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&in); err != nil || in.KeepCurrent == nil {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusBadRequest, Code: httpx.CodeBadRequest,
			Detail: "keep_current is required."})
		return
	}
	keep := pgtype.UUID{Valid: true} // the nil UUID matches no session
	if *in.KeepCurrent {
		keep = p.Session.ID
	}
	n, err := h.Users.DeleteOtherSessions(r.Context(), store.DeleteOtherSessionsParams{UserID: p.User.ID, Keep: keep})
	if err != nil {
		h.unavailable(w, r, "end sessions", err)
		return
	}
	h.Audit.Record(r.Context(), audit.Event{
		Actor: p.User.ID, Action: audit.SessionsEndedAll, IP: p.IP,
		Detail: map[string]any{"ended": n, "kept_current": *in.KeepCurrent},
	})
	h.sessionsEnded(r.Context(), p.User.ID)
	if !*in.KeepCurrent {
		h.Cookies.clearSession(w)
	}
	httpx.WriteJSON(w, http.StatusOK, struct {
		Ended int64 `json:"ended"`
	}{n})
}

// backchannelEvent marks a logout token (OpenID Connect Back-Channel Logout 1.0).
const backchannelEvent = "http://schemas.openid.net/event/backchannel-logout"

// logoutTokenTTL bounds how long a logout token's id is remembered against replay.
const logoutTokenTTL = 10 * time.Minute

type logoutClaims struct {
	Sub    string                     `json:"sub"`
	SID    string                     `json:"sid"`
	JTI    string                     `json:"jti"`
	Nonce  *string                    `json:"nonce"`
	Events map[string]json.RawMessage `json:"events"`
}

func backchannelError(w http.ResponseWriter, description string) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusBadRequest)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": "invalid_request", "error_description": description})
}

// BackchannelLogout implements api.ServerInterface: Cenacle ID ended a
// sign-in, so the sessions created from it end too (open WebSockets close at
// their next session check).
func (h *Handlers) BackchannelLogout(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	if err := r.ParseForm(); err != nil {
		backchannelError(w, "The body is not a form.")
		return
	}
	raw := r.PostForm.Get("logout_token")
	if raw == "" {
		backchannelError(w, "logout_token is missing.")
		return
	}
	claims, err := h.verifyLogoutToken(r.Context(), raw)
	if err != nil {
		h.Log.InfoContext(r.Context(), "logout token rejected", "error", err)
		backchannelError(w, "The logout token is invalid.")
		return
	}
	// Each token works once; if ending the sessions fails, the mark is taken
	// back so the identity provider can retry.
	jtiKey := "cenacle:auth:logout-jti:" + claims.JTI
	if err := h.Flows.PutNew(r.Context(), jtiKey, []byte{1}, logoutTokenTTL); err != nil {
		h.Log.InfoContext(r.Context(), "logout token replayed", "error", err)
		backchannelError(w, "The logout token was used before.")
		return
	}
	var ended []pgtype.UUID
	if claims.SID != "" {
		ended, err = h.Users.DeleteSessionsByIdpSid(r.Context(), store.DeleteSessionsByIdpSidParams{
			IdpSid: claims.SID, AuthService: AuthService, AuthData: claims.Sub,
		})
	} else {
		ended, err = h.Users.DeleteSessionsBySubject(r.Context(), store.DeleteSessionsBySubjectParams{
			AuthService: AuthService, AuthData: claims.Sub,
		})
	}
	if err != nil {
		h.Log.ErrorContext(r.Context(), "back-channel logout", "error", err)
		_, _ = h.Flows.Take(context.WithoutCancel(r.Context()), jtiKey)
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	if len(ended) > 0 {
		h.Audit.Record(r.Context(), audit.Event{
			Actor: ended[0], Action: audit.SessionsEndedByID,
			Detail: map[string]any{"ended": len(ended), "sid": claims.SID != ""},
		})
		h.sessionsEnded(r.Context(), ended[0]) // one identity, one user
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
}

// verifyLogoutToken checks signature, issuer, audience and expiry like an ID
// token, then the logout token rules: the logout event, no nonce, a subject
// and an id.
func (h *Handlers) verifyLogoutToken(ctx context.Context, raw string) (logoutClaims, error) {
	provider, _, err := h.IdP.discover(ctx)
	if err != nil {
		return logoutClaims{}, err
	}
	tok, err := provider.Verifier(&oidc.Config{ClientID: h.IdP.ClientID}).Verify(h.IdP.clientContext(ctx), raw)
	if err != nil {
		return logoutClaims{}, err
	}
	var c logoutClaims
	if err := tok.Claims(&c); err != nil {
		return logoutClaims{}, err
	}
	switch {
	case c.Events == nil || c.Events[backchannelEvent] == nil:
		return c, errors.New("no back-channel logout event")
	case c.Nonce != nil:
		return c, errors.New("logout tokens carry no nonce")
	case strings.TrimSpace(c.Sub) == "":
		// Cenacle ID always names the subject; sessions are found through it.
		return c, errors.New("no subject")
	case c.JTI == "":
		return c, errors.New("no token id")
	}
	return c, nil
}

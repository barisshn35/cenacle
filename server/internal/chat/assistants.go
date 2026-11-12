// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/audit"
	"github.com/Cenacle-TR/cenacle/server/internal/auth"
	"github.com/Cenacle-TR/cenacle/server/internal/httpx"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

// Assistants over MCP (ADR 0056): personal tokens and the drafts assistants
// leave in message boxes.

// MaxAssistantTokens is how many working tokens one person may have.
const MaxAssistantTokens = 10

// CodeAssistantsOff: the installation does not allow assistants.
const CodeAssistantsOff = "assistants_off"

func (h *Handlers) mcpURL() string { return strings.TrimSuffix(h.PublicURL, "/") + auth.MCPPath }

func assistantTokenAPI(id pgtype.UUID, name string, scopes []string, created, expires time.Time, used pgtype.Timestamptz) api.AssistantToken {
	return api.AssistantToken{Id: uuid(id), Name: name, Scopes: scopes, CreatedAt: created, ExpiresAt: expires, LastUsedAt: timePtr(used)}
}

// people only: bots and assistants do not manage assistants.
func person(w http.ResponseWriter, r *http.Request, p auth.Principal) bool {
	if p.Bot != nil || p.Assistant != nil {
		forbidden(w, r, httpx.CodeForbidden, "Only people manage their assistants.")
		return false
	}
	return true
}

// ListAssistantTokens implements api.ServerInterface.
func (h *Handlers) ListAssistantTokens(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !person(w, r, p) {
		return
	}
	allowed, err := h.Queries.GetAssistantsEnabled(r.Context())
	if err != nil {
		h.unavailable(w, r, "assistants policy", err)
		return
	}
	rows, err := h.Queries.ListAssistantTokens(r.Context(), p.User.ID)
	if err != nil {
		h.unavailable(w, r, "assistant tokens", err)
		return
	}
	out := make([]api.AssistantToken, 0, len(rows))
	for _, t := range rows {
		out = append(out, assistantTokenAPI(t.ID, t.Name, t.Scopes, t.CreatedAt, t.ExpiresAt, t.LastUsedAt))
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"allowed": allowed, "mcp_url": h.mcpURL(), "tokens": out})
}

// CreateAssistantToken implements api.ServerInterface.
func (h *Handlers) CreateAssistantToken(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !person(w, r, p) {
		return
	}
	var in struct {
		Name   string   `json:"name"`
		Scopes []string `json:"scopes"`
		Days   int      `json:"days"`
	}
	if !decode(w, r, &in) {
		return
	}
	name := strings.TrimSpace(in.Name)
	scopes := []string{auth.ScopeAssistantRead}
	for _, s := range in.Scopes {
		switch s {
		case auth.ScopeAssistantRead:
		case auth.ScopeAssistantDraft:
			if !slices.Contains(scopes, s) {
				scopes = append(scopes, s)
			}
		default:
			badRequest(w, r, "Scopes are read and draft.")
			return
		}
	}
	if name == "" || len([]rune(name)) > 80 || (in.Days != 7 && in.Days != 30 && in.Days != 90) {
		badRequest(w, r, "A token has a name of 1 to 80 characters and lasts 7, 30 or 90 days.")
		return
	}
	allowed, err := h.Queries.GetAssistantsEnabled(r.Context())
	if err != nil {
		h.unavailable(w, r, "assistants policy", err)
		return
	}
	if !allowed {
		forbidden(w, r, CodeAssistantsOff, "This server does not allow assistants.")
		return
	}
	if n, err := h.Queries.CountAssistantTokens(r.Context(), p.User.ID); err != nil {
		h.unavailable(w, r, "count assistant tokens", err)
		return
	} else if n >= MaxAssistantTokens {
		badRequest(w, r, "At most 10 assistant tokens; revoke one first.")
		return
	}
	token, hash := auth.NewAssistantToken()
	t, err := h.Queries.CreateAssistantToken(r.Context(), store.CreateAssistantTokenParams{
		UserID: p.User.ID, Name: name, TokenHash: hash, Scopes: scopes,
		ExpiresAt: time.Now().Add(time.Duration(in.Days) * 24 * time.Hour),
	})
	if err != nil {
		h.unavailable(w, r, "create assistant token", err)
		return
	}
	h.record(r, pgtype.UUID{}, audit.AssistantTokenCreated, "assistant_token", uuid(t.ID).String(),
		map[string]any{"name": name, "scopes": scopes, "days": in.Days})
	out := assistantTokenAPI(t.ID, t.Name, t.Scopes, t.CreatedAt, t.ExpiresAt, t.LastUsedAt)
	httpx.WriteJSON(w, http.StatusCreated, map[string]any{
		"id": out.Id, "name": out.Name, "scopes": out.Scopes, "created_at": out.CreatedAt,
		"expires_at": out.ExpiresAt, "last_used_at": out.LastUsedAt, "token": token,
	})
}

// RevokeAssistantToken implements api.ServerInterface.
func (h *Handlers) RevokeAssistantToken(w http.ResponseWriter, r *http.Request, id openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !person(w, r, p) {
		return
	}
	n, err := h.Queries.RevokeAssistantToken(r.Context(), store.RevokeAssistantTokenParams{ID: pgUUID(id), UserID: p.User.ID})
	if err != nil {
		h.unavailable(w, r, "revoke assistant token", err)
		return
	}
	if n == 0 {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No such token."})
		return
	}
	h.record(r, pgtype.UUID{}, audit.AssistantTokenRevoked, "assistant_token", id.String(), nil)
	w.WriteHeader(http.StatusNoContent)
}

// ListAssistantDrafts implements api.ServerInterface.
func (h *Handlers) ListAssistantDrafts(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !person(w, r, p) {
		return
	}
	rows, err := h.Queries.ListAssistantDrafts(r.Context(), p.User.ID)
	if err != nil {
		h.unavailable(w, r, "assistant drafts", err)
		return
	}
	out := make([]api.AssistantDraft, 0, len(rows))
	for _, d := range rows {
		item := api.AssistantDraft{ChannelId: uuid(d.ChannelID), Body: d.Body, CreatedAt: d.CreatedAt, Assistant: d.Assistant}
		if d.RootID.Valid {
			root := uuid(d.RootID)
			item.RootId = &root
		}
		out = append(out, item)
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"drafts": out})
}

// DeleteAssistantDraft implements api.ServerInterface.
func (h *Handlers) DeleteAssistantDraft(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !person(w, r, p) {
		return
	}
	if _, err := h.Queries.DeleteAssistantDraft(r.Context(), store.DeleteAssistantDraftParams{UserID: p.User.ID, ChannelID: pgUUID(channelID)}); err != nil {
		h.unavailable(w, r, "delete assistant draft", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// GetAssistantsPolicy implements api.ServerInterface.
func (h *Handlers) GetAssistantsPolicy(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !requireInstanceAdmin(w, r, p) {
		return
	}
	on, err := h.Queries.GetAssistantsEnabled(r.Context())
	if err != nil {
		h.unavailable(w, r, "assistants policy", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, api.AssistantsPolicy{Enabled: on})
}

// SetAssistantsPolicy implements api.ServerInterface.
func (h *Handlers) SetAssistantsPolicy(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !requireInstanceAdmin(w, r, p) {
		return
	}
	var in api.AssistantsPolicy
	if !decode(w, r, &in) {
		return
	}
	if err := h.Queries.SetAssistantsEnabled(r.Context(), in.Enabled); err != nil {
		h.unavailable(w, r, "set assistants policy", err)
		return
	}
	h.record(r, pgtype.UUID{}, audit.AssistantsChanged, "instance", "assistants", map[string]any{"enabled": in.Enabled})
	httpx.WriteJSON(w, http.StatusOK, in)
}

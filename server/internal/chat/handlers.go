// SPDX-License-Identifier: Apache-2.0

// Package chat serves channels and messages.
package chat

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/audit"
	"github.com/barisshn35/cenacle/server/internal/auth"
	"github.com/barisshn35/cenacle/server/internal/events"
	"github.com/barisshn35/cenacle/server/internal/httpx"
	"github.com/barisshn35/cenacle/server/internal/store"
)

// Limits of message bodies (characters) and pages.
const (
	MaxBodyLength = 4000
	defaultPage   = 50
)

// RateLimiter counts actions in a fixed window (cache.Client.Hit).
type RateLimiter interface {
	Hit(ctx context.Context, key string, window time.Duration) (int64, time.Duration, error)
}

// Handlers implements the chat operations of the API.
type Handlers struct {
	Queries store.Querier
	Events  *events.Log
	// Ephemeral carries typing notices; optional.
	Ephemeral *events.Ephemeral
	// Audit records security-relevant actions; optional.
	Audit   *audit.Log
	Limiter RateLimiter
	Cookies auth.Cookies
	Log     *slog.Logger
	// Configured lists the channels of the installation settings, which keep
	// their names.
	Configured []string
	// MessagesPerWindow and Window limit how fast one user can send.
	MessagesPerWindow int64
	Window            time.Duration
}

func uuid(id pgtype.UUID) openapi_types.UUID { return id.Bytes }

func pgUUID(id openapi_types.UUID) pgtype.UUID { return pgtype.UUID{Bytes: id, Valid: true} }

func (h *Handlers) unavailable(w http.ResponseWriter, r *http.Request, msg string, err error) {
	h.Log.ErrorContext(r.Context(), msg, "error", err, "request_id", httpx.RequestIDFrom(r.Context()))
	httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusServiceUnavailable, Code: httpx.CodeUnavailable})
}

func channelNotFound(w http.ResponseWriter, r *http.Request) {
	httpx.WriteProblem(w, r, httpx.Problem{
		Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No channel with this id.",
	})
}

// channel loads a channel or answers 404.
func (h *Handlers) channel(w http.ResponseWriter, r *http.Request, id openapi_types.UUID) (store.Channel, bool) {
	c, err := h.Queries.GetChannel(r.Context(), pgUUID(id))
	if isNoRows(err) {
		channelNotFound(w, r)
		return c, false
	}
	if err != nil {
		h.unavailable(w, r, "get channel", err)
		return c, false
	}
	return c, true
}

// ListMessages implements api.ServerInterface.
func (h *Handlers) ListMessages(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID, params api.ListMessagesParams) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	if _, _, ok = h.memberChannel(w, r, channelID, p.User); !ok {
		return
	}
	limit := defaultPage
	if params.Limit != nil {
		limit = *params.Limit
	}
	if limit < 1 || limit > 100 {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusBadRequest, Code: httpx.CodeBadRequest,
			Detail: "limit must be between 1 and 100."})
		return
	}
	var before pgtype.UUID
	if params.Before != nil {
		before = pgUUID(*params.Before)
	}
	// One extra row tells whether older messages exist.
	rows, err := h.Queries.ListMessagesBefore(r.Context(), store.ListMessagesBeforeParams{
		ChannelID: pgUUID(channelID), Before: before, RowLimit: int32(limit + 1),
	})
	if err != nil {
		h.unavailable(w, r, "list messages", err)
		return
	}
	hasMore := len(rows) > limit
	if hasMore {
		rows = rows[:limit]
	}
	page := api.MessagePage{HasMore: hasMore, Messages: make([]api.Message, len(rows))}
	for i, m := range rows {
		// Rows come newest first; pages are chronological.
		page.Messages[len(rows)-1-i] = messageAPI(store.Message{
			ID: m.ID, ChannelID: m.ChannelID, AuthorID: m.AuthorID, Body: m.Body, Nonce: m.Nonce,
			CreatedAt: m.CreatedAt, EditedAt: m.EditedAt,
		}, m.AuthorName)
	}
	httpx.WriteJSON(w, http.StatusOK, page)
}

// validBody trims surrounding blank lines and spaces and checks the length.
func validBody(body string) (string, string) {
	body = strings.TrimSpace(body)
	switch {
	case body == "":
		return "", "The message is empty."
	case !utf8.ValidString(body) || strings.ContainsRune(body, 0):
		return "", "The message contains invalid characters."
	case utf8.RuneCountInString(body) > MaxBodyLength:
		return "", "The message is longer than 4000 characters."
	}
	return body, ""
}

// CreateMessage implements api.ServerInterface.
func (h *Handlers) CreateMessage(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.NewMessage
	if !decode(w, r, &in) {
		return
	}
	body, problem := validBody(in.Body)
	if problem == "" && (len(in.Nonce) < 8 || len(in.Nonce) > 64) {
		problem = "The nonce must have 8 to 64 characters."
	}
	if problem != "" {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusBadRequest, Code: httpx.CodeBadRequest, Detail: problem})
		return
	}
	c, role, ok := h.memberChannel(w, r, channelID, p.User)
	if !ok {
		return
	}
	if c.ArchivedAt.Valid {
		forbidden(w, r, CodeChannelArchived, "The channel is archived.")
		return
	}
	if !canPost(c, role) {
		forbidden(w, r, CodeReadOnlyChannel, "Only the workspace's owners and admins can send messages in this channel.")
		return
	}

	key := "cenacle:rl:messages:" + uuid(p.User.ID).String()
	n, wait, err := h.Limiter.Hit(r.Context(), key, h.Window)
	if err != nil {
		h.unavailable(w, r, "rate limit", err)
		return
	}
	if n > h.MessagesPerWindow {
		w.Header().Set("Retry-After", strconv.Itoa(int((wait+time.Second-1)/time.Second)))
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusTooManyRequests, Code: httpx.CodeRateLimited,
			Detail: "Too many messages in a short time."})
		return
	}

	msg, err := h.Queries.CreateMessage(r.Context(), store.CreateMessageParams{
		ChannelID: pgUUID(channelID), AuthorID: p.User.ID, Body: body, Nonce: in.Nonce,
	})
	if isNoRows(err) {
		// The nonce was used before: this is a retry of a message that exists.
		msg, err = h.Queries.GetMessageByNonce(r.Context(), store.GetMessageByNonceParams{
			AuthorID: p.User.ID, Nonce: in.Nonce,
		})
	}
	if err != nil {
		h.unavailable(w, r, "create message", err)
		return
	}
	out := messageAPI(msg, p.User.DisplayName)
	// What you send, you have read. No channel.read: the sender's other
	// devices see message.created and move their read position themselves.
	if _, err := h.Queries.MarkRead(r.Context(), store.MarkReadParams{ChannelID: c.ID, UserID: p.User.ID, MessageID: msg.ID}); err != nil {
		h.Log.WarnContext(r.Context(), "mark own message read", "error", err)
	}
	// The message is stored; if the event cannot be appended, clients still
	// see it when they load the channel (a transactional outbox follows in v0.9).
	h.publish(r.Context(), events.MessageCreated, out)
	httpx.WriteJSON(w, http.StatusCreated, out)
}

// messageAPI describes a stored message with its author's name.
func messageAPI(m store.Message, authorName string) api.Message {
	out := api.Message{
		Id: uuid(m.ID), ChannelId: uuid(m.ChannelID), Body: m.Body, Nonce: m.Nonce, CreatedAt: m.CreatedAt,
		Author: api.Author{Id: uuid(m.AuthorID), DisplayName: authorName},
	}
	if m.EditedAt.Valid {
		t := m.EditedAt.Time
		out.EditedAt = &t
	}
	return out
}

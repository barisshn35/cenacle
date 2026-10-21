// SPDX-License-Identifier: Apache-2.0

// Package chat serves channels and messages.
package chat

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/barisshn35/cenacle/server/internal/api"
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
	Limiter RateLimiter
	Cookies auth.Cookies
	Log     *slog.Logger
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

// ListChannels implements api.ServerInterface.
func (h *Handlers) ListChannels(w http.ResponseWriter, r *http.Request) {
	if _, ok := auth.RequirePrincipal(w, r, h.Cookies); !ok {
		return
	}
	rows, err := h.Queries.ListChannels(r.Context())
	if err != nil {
		h.unavailable(w, r, "list channels", err)
		return
	}
	out := make([]api.Channel, 0, len(rows))
	for _, c := range rows {
		out = append(out, api.Channel{Id: uuid(c.ID), Name: c.Name, Topic: c.Topic})
	}
	httpx.WriteJSON(w, http.StatusOK, struct {
		Channels []api.Channel `json:"channels"`
	}{out})
}

// channel loads a channel or answers 404.
func (h *Handlers) channel(w http.ResponseWriter, r *http.Request, id openapi_types.UUID) (store.Channel, bool) {
	c, err := h.Queries.GetChannel(r.Context(), pgUUID(id))
	if errors.Is(err, pgx.ErrNoRows) {
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
	if _, ok := auth.RequirePrincipal(w, r, h.Cookies); !ok {
		return
	}
	if _, ok := h.channel(w, r, channelID); !ok {
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
		page.Messages[len(rows)-1-i] = api.Message{
			Id: uuid(m.ID), ChannelId: uuid(m.ChannelID), Body: m.Body, Nonce: m.Nonce, CreatedAt: m.CreatedAt,
			Author: api.Author{Id: uuid(m.AuthorID), DisplayName: m.AuthorName},
		}
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
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&in); err != nil {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusBadRequest, Code: httpx.CodeBadRequest,
			Detail: "The body must be a JSON object with body and nonce."})
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
	if _, ok := h.channel(w, r, channelID); !ok {
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
	if errors.Is(err, pgx.ErrNoRows) {
		// The nonce was used before: this is a retry of a message that exists.
		msg, err = h.Queries.GetMessageByNonce(r.Context(), store.GetMessageByNonceParams{
			AuthorID: p.User.ID, Nonce: in.Nonce,
		})
	}
	if err != nil {
		h.unavailable(w, r, "create message", err)
		return
	}
	out := api.Message{
		Id: uuid(msg.ID), ChannelId: uuid(msg.ChannelID), Body: msg.Body, Nonce: msg.Nonce, CreatedAt: msg.CreatedAt,
		Author: api.Author{Id: uuid(p.User.ID), DisplayName: p.User.DisplayName},
	}
	// The message is stored; if the event cannot be appended, clients still
	// see it when they load the channel (a transactional outbox follows in v0.9).
	if _, err := h.Events.Append(r.Context(), events.MessageCreated, out); err != nil {
		h.Log.ErrorContext(r.Context(), "append message event", "error", err,
			"request_id", httpx.RequestIDFrom(r.Context()))
	}
	httpx.WriteJSON(w, http.StatusCreated, out)
}

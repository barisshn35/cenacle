// SPDX-License-Identifier: Apache-2.0

// Package chat serves channels and messages.
package chat

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/audit"
	"github.com/barisshn35/cenacle/server/internal/auth"
	"github.com/barisshn35/cenacle/server/internal/egress"
	"github.com/barisshn35/cenacle/server/internal/events"
	"github.com/barisshn35/cenacle/server/internal/httpx"
	"github.com/barisshn35/cenacle/server/internal/store"
	"github.com/barisshn35/cenacle/server/internal/telemetry"
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
	// DB starts the transactions that write a change and its event together.
	DB TxBeginner
	// Ephemeral carries typing notices; optional.
	Ephemeral *events.Ephemeral
	// Audit records security-relevant actions; optional.
	Audit *audit.Log
	// Egress sends requests to bots (slash commands); optional.
	Egress *egress.Client
	// Files is the object store for files; nil or without a store: files are off.
	Files *Files
	// AdminEmail is the configured instance administrator's address (group
	// mappings re-apply roles).
	AdminEmail string
	// PublicURL is the app's origin, for webhook addresses.
	PublicURL string
	Limiter   RateLimiter
	Cookies   auth.Cookies
	Log       *slog.Logger
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
			CreatedAt: m.CreatedAt, EditedAt: m.EditedAt, Attachments: m.Attachments,
		}, m.AuthorName, m.AuthorIsBot)
	}
	if err := decorate(r.Context(), h.Queries, p.User.ID, page.Messages); err != nil {
		h.unavailable(w, r, "list reactions and mentions", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, page)
}

// validBody trims surrounding blank lines and spaces and checks the length.
// allowMessage counts a message (or command) of the user against the rate
// limit; past it, it answers 429 and returns false.
func (h *Handlers) allowMessage(w http.ResponseWriter, r *http.Request, user store.User) bool {
	n, wait, err := h.Limiter.Hit(r.Context(), "cenacle:rl:messages:"+uuid(user.ID).String(), h.Window)
	if err != nil {
		h.unavailable(w, r, "rate limit", err)
		return false
	}
	if n > h.MessagesPerWindow {
		w.Header().Set("Retry-After", strconv.Itoa(int((wait+time.Second-1)/time.Second)))
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusTooManyRequests, Code: httpx.CodeRateLimited,
			Detail: "Too many messages in a short time."})
		return false
	}
	return true
}

// errNonceReused: the author used the nonce for another message.
var errNonceReused = errors.New("nonce reused")

// CodeNonceReused answers a nonce used before for another message.
const CodeNonceReused = "nonce_reused"

func trimBody(body string) string { return strings.TrimSpace(body) }

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
	attachments, rawAttachments, problem := cleanAttachments(in.Attachments)
	var files []pgtype.UUID
	if in.FileIds != nil {
		if len(*in.FileIds) > MaxFilesPerMessage {
			problem = "A message can carry up to 10 files."
		}
		for _, id := range *in.FileIds {
			if f := pgUUID(id); !slices.Contains(files, f) {
				files = append(files, f)
			}
		}
	}
	body := strings.TrimSpace(in.Body)
	if problem == "" && (body != "" || (len(attachments) == 0 && len(files) == 0)) {
		body, problem = validBody(in.Body)
	}
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

	if !h.allowMessage(w, r, p.User) {
		return
	}

	// The message, its mentions, the author's read position and the event are
	// written together: the event cannot get lost (transactional outbox).
	var out api.Message
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		var err error
		out, err = postMessage(r.Context(), q, c, p.User, body, in.Nonce, rawAttachments, files...)
		return err
	})
	if errors.Is(err, errFilesUnavailable) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusBadRequest, Code: CodeFilesUnavailable,
			Detail: "Some files are not ready, not yours, in another channel or already sent."})
		return
	}
	if errors.Is(err, errNonceReused) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeNonceReused,
			Detail: "This nonce belongs to another message; use a new one."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "create message", err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, out)
}

// postMessage stores a message with its mentions, marks it read for its
// author and records message.created, inside the caller's transaction. A
// nonce the author used before returns that message (a retry).
func postMessage(ctx context.Context, q *store.Queries, c store.Channel, author store.User, body, nonce string, rawAttachments []byte, files ...pgtype.UUID) (api.Message, error) {
	msg, err := q.CreateMessage(ctx, store.CreateMessageParams{
		ChannelID: c.ID, AuthorID: author.ID, Body: body, Nonce: nonce, Attachments: rawAttachments,
		HasFiles: len(files) > 0,
	})
	if isNoRows(err) {
		msg, err = q.GetMessageByNonce(ctx, store.GetMessageByNonceParams{AuthorID: author.ID, Nonce: nonce})
		if err != nil {
			return api.Message{}, err
		}
		// A retry is the same message in the same channel; anything else reuses
		// a nonce by mistake.
		if msg.ChannelID != c.ID || msg.DeletedAt.Valid {
			return api.Message{}, errNonceReused
		}
		msgs := []api.Message{messageAPI(msg, author.DisplayName, author.IsBot)}
		err = decorate(ctx, q, author.ID, msgs)
		return msgs[0], err
	}
	if err != nil {
		return api.Message{}, err
	}
	telemetry.Messages.Inc()
	if len(files) > 0 {
		n, err := q.AttachFiles(ctx, store.AttachFilesParams{
			MessageID: msg.ID, Ids: files, UploaderID: author.ID, ChannelID: c.ID,
		})
		if err != nil {
			return api.Message{}, err
		}
		if n != int64(len(files)) {
			return api.Message{}, errFilesUnavailable
		}
	}
	if ids := mentionedIDs(body); len(ids) > 0 {
		if err := q.AddMentions(ctx, store.AddMentionsParams{MessageID: msg.ID, ChannelID: c.ID, UserIds: ids}); err != nil {
			return api.Message{}, err
		}
	}
	// What you send, you have read. No channel.read: the sender's other
	// devices see message.created and move their read position themselves.
	if _, err := q.MarkRead(ctx, store.MarkReadParams{ChannelID: c.ID, UserID: author.ID, MessageID: msg.ID}); err != nil {
		return api.Message{}, err
	}
	msgs := []api.Message{messageAPI(msg, author.DisplayName, author.IsBot)}
	if err := decorate(ctx, q, author.ID, msgs); err != nil {
		return api.Message{}, err
	}
	return msgs[0], emit(ctx, q, events.MessageCreated, msgs[0])
}

// messageAPI describes a stored message with its author's name; mentions
// and reactions are filled by decorate.
func messageAPI(m store.Message, authorName string, authorIsBot bool) api.Message {
	out := api.Message{
		Id: uuid(m.ID), ChannelId: uuid(m.ChannelID), Body: m.Body, Nonce: m.Nonce, CreatedAt: m.CreatedAt,
		Author:   api.Author{Id: uuid(m.AuthorID), DisplayName: authorName},
		Mentions: []api.Author{}, Reactions: []api.Reaction{}, Attachments: []api.Attachment{},
		Files: []api.FileInfo{},
	}
	if len(m.Attachments) > 0 {
		_ = json.Unmarshal(m.Attachments, &out.Attachments)
	}
	if authorIsBot {
		out.Author.IsBot = &authorIsBot
	}
	if m.EditedAt.Valid {
		t := m.EditedAt.Time
		out.EditedAt = &t
	}
	return out
}

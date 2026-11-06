// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"context"
	"log/slog"
	"net/http"

	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/Cenacle-TR/cenacle/server/internal/auth"
	"github.com/Cenacle-TR/cenacle/server/internal/events"
	"github.com/Cenacle-TR/cenacle/server/internal/httpx"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

// CodeNoAck is the problem code of acknowledging a message that does not ask for it.
const CodeNoAck = "no_ack_requested"

// AckEvent is the data of message.ack: someone acknowledged a message, or
// took it back.
type AckEvent struct {
	ChannelID   string `json:"channel_id"`
	MessageID   string `json:"message_id"`
	UserID      string `json:"user_id"`
	DisplayName string `json:"display_name"`
	Acked       bool   `json:"acked"`
}

// ReminderEvent is the data of message.reminder: an urgent message still
// waits for the person's acknowledgement.
type ReminderEvent struct {
	UserID      string `json:"user_id"`
	ChannelID   string `json:"channel_id"`
	MessageID   string `json:"message_id"`
	AuthorName  string `json:"author_name"`
	ChannelName string `json:"channel_name"`
	ChannelKind string `json:"channel_kind"`
	Body        string `json:"body"`
}

// AckMessage implements api.ServerInterface.
func (h *Handlers) AckMessage(w http.ResponseWriter, r *http.Request, channelID, messageID openapi_types.UUID) {
	h.ack(w, r, channelID, messageID, true)
}

// UnackMessage implements api.ServerInterface.
func (h *Handlers) UnackMessage(w http.ResponseWriter, r *http.Request, channelID, messageID openapi_types.UUID) {
	h.ack(w, r, channelID, messageID, false)
}

func (h *Handlers) ack(w http.ResponseWriter, r *http.Request, channelID, messageID openapi_types.UUID, acked bool) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	if !h.allowAction(w, r, p.User) {
		return
	}
	c, _, m, ok := h.message(w, r, channelID, messageID, p.User)
	if !ok {
		return
	}
	if m.DeletedAt.Valid {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "The message was deleted."})
		return
	}
	if !m.AckRequested {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeNoAck,
			Detail: "This message does not ask for acknowledgements."})
		return
	}
	ctx := r.Context()
	err := h.inTx(ctx, func(q *store.Queries) error {
		var n int64
		var err error
		if acked {
			n, err = q.AckMessage(ctx, store.AckMessageParams{MessageID: m.ID, UserID: p.User.ID})
		} else {
			n, err = q.UnackMessage(ctx, store.UnackMessageParams{MessageID: m.ID, UserID: p.User.ID})
		}
		if err != nil || n == 0 {
			return err
		}
		return emit(ctx, q, events.MessageAck, AckEvent{
			ChannelID: uuid(c.ID).String(), MessageID: uuid(m.ID).String(),
			UserID: uuid(p.User.ID).String(), DisplayName: p.User.DisplayName, Acked: acked,
		})
	})
	if err != nil {
		h.unavailable(w, r, "acknowledge", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Reminders reminds the people urgent messages mention until they
// acknowledge them, as often and as many times as their workspace allows.
type Reminders struct {
	DB      TxBeginner
	Queries *store.Queries
	Log     *slog.Logger
}

// Run sends the reminders that are due; it returns how many.
func (rm *Reminders) Run(ctx context.Context) (int, error) {
	due, err := rm.Queries.DueReminders(ctx)
	if err != nil || len(due) == 0 {
		return 0, err
	}
	sent := 0
	for _, d := range due {
		err := inTx(ctx, rm.DB, func(q *store.Queries) error {
			if err := q.RecordReminder(ctx, store.RecordReminderParams{MessageID: d.MessageID, UserID: d.UserID}); err != nil {
				return err
			}
			return emit(ctx, q, events.MessageReminder, ReminderEvent{
				UserID: uuid(d.UserID).String(), ChannelID: uuid(d.ChannelID).String(),
				MessageID: uuid(d.MessageID).String(), AuthorName: d.AuthorName,
				ChannelName: d.ChannelName, ChannelKind: d.ChannelKind, Body: excerptOf(d.Body, 160),
			})
		})
		if err != nil {
			return sent, err
		}
		sent++
	}
	return sent, nil
}

// excerptOf is the start of a text, at most n characters.
func excerptOf(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}

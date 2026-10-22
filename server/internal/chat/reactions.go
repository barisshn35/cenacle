// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"net/http"

	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/auth"
	"github.com/barisshn35/cenacle/server/internal/events"
	"github.com/barisshn35/cenacle/server/internal/httpx"
	"github.com/barisshn35/cenacle/server/internal/store"
)

// CodeTooManyReactions: a message has MaxReactionKinds kinds of reactions.
const CodeTooManyReactions = "too_many_reactions"

// ReactionEvent is the data of reaction.added and reaction.removed.
type ReactionEvent struct {
	ChannelID string `json:"channel_id"`
	MessageID string `json:"message_id"`
	Emoji     string `json:"emoji"`
	UserID    string `json:"user_id"`
}

// AddReaction implements api.ServerInterface.
func (h *Handlers) AddReaction(w http.ResponseWriter, r *http.Request, channelID, messageID openapi_types.UUID, emoji string) {
	h.react(w, r, channelID, messageID, emoji, true)
}

// RemoveReaction implements api.ServerInterface.
func (h *Handlers) RemoveReaction(w http.ResponseWriter, r *http.Request, channelID, messageID openapi_types.UUID, emoji string) {
	h.react(w, r, channelID, messageID, emoji, false)
}

func (h *Handlers) react(w http.ResponseWriter, r *http.Request, channelID, messageID openapi_types.UUID, emoji string, add bool) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	custom := customEmojiName(emoji)
	if custom == "" && !validEmoji(emoji) {
		badRequest(w, r, "A reaction is one emoji.")
		return
	}
	c, _, m, ok := h.message(w, r, channelID, messageID, p.User)
	if !ok {
		return
	}
	switch {
	case m.DeletedAt.Valid:
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound,
			Detail: "The message was deleted."})
		return
	case c.ArchivedAt.Valid:
		forbidden(w, r, CodeChannelArchived, "The channel is archived.")
		return
	case add && h.timedOut(w, r, c.WorkspaceID, p.User):
		return
	}
	if add && custom != "" {
		exists, err := h.Queries.CustomEmojiExists(r.Context(), store.CustomEmojiExistsParams{WorkspaceID: c.WorkspaceID, Name: custom})
		if err != nil {
			h.unavailable(w, r, "react", err)
			return
		}
		if !exists {
			badRequest(w, r, "No such custom emoji in this workspace.")
			return
		}
	}
	ev := ReactionEvent{ChannelID: uuid(c.ID).String(), MessageID: uuid(m.ID).String(), Emoji: emoji,
		UserID: uuid(p.User.ID).String()}
	tooMany := false
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		params := store.AddReactionParams{MessageID: m.ID, Emoji: emoji, UserID: p.User.ID}
		if !add {
			n, err := q.RemoveReaction(r.Context(), store.RemoveReactionParams(params))
			if err != nil || n == 0 {
				return err
			}
			return emit(r.Context(), q, events.ReactionRemoved, ev)
		}
		n, err := q.AddReaction(r.Context(), params)
		if err != nil || n == 0 {
			return err
		}
		kinds, err := q.CountReactionKinds(r.Context(), m.ID)
		if err != nil {
			return err
		}
		if kinds > MaxReactionKinds {
			tooMany = true
			return errRollback
		}
		if err := emit(r.Context(), q, events.ReactionAdded, ev); err != nil {
			return err
		}
		if m.BurnSeconds.Valid {
			return nil
		}
		return triggerWorkflows(r.Context(), q, TriggerReaction, c, p.User,
			func(t api.WorkflowTrigger) bool { return t.Emoji != nil && *t.Emoji == emoji },
			runVars{"trigger.emoji": emoji, "trigger.message": m.Body})
	})
	if tooMany {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusBadRequest, Code: CodeTooManyReactions,
			Detail: "This message has as many kinds of reactions as it can."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "react", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

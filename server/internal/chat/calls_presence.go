// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"net/http"
	"time"

	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/auth"
	"github.com/Cenacle-TR/cenacle/server/internal/events"
	"github.com/Cenacle-TR/cenacle/server/internal/httpx"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

// CallReactionInterval is how often one person's reactions go out in a call.
const CallReactionInterval = time.Second

func notInCall(w http.ResponseWriter, r *http.Request) {
	httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: "not_in_call",
		Detail: "You are not in this call."})
}

// SetCallHand implements api.ServerInterface.
func (h *Handlers) SetCallHand(w http.ResponseWriter, r *http.Request, id openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.SetCallHandJSONBody
	if !decode(w, r, &in) {
		return
	}
	call, ok := h.accessibleCall(w, r, id, p)
	if !ok {
		return
	}
	changed := false
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		locked, e := q.LockCall(r.Context(), call.ID)
		if e != nil || locked.EndedAt.Valid {
			return e
		}
		n, e := q.SetCallHand(r.Context(), store.SetCallHandParams{Raised: in.Raised, CallID: call.ID, UserID: p.User.ID})
		if e != nil || n == 0 {
			return e
		}
		changed = true
		bumped, e := q.BumpCallRevision(r.Context(), call.ID)
		if e != nil {
			return e
		}
		return emitCall(r.Context(), q, bumped, events.CallParticipants)
	})
	if err != nil {
		h.callError(w, r, err)
		return
	}
	if !changed {
		notInCall(w, r)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// CallReactionEvent is the data of call.reaction.
type CallReactionEvent struct {
	CallID    string `json:"call_id"`
	ChannelID string `json:"channel_id"`
	UserID    string `json:"user_id"`
	Emoji     string `json:"emoji"`
}

// SendCallReaction implements api.ServerInterface.
func (h *Handlers) SendCallReaction(w http.ResponseWriter, r *http.Request, id openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.SendCallReactionJSONBody
	if !decode(w, r, &in) {
		return
	}
	if !validEmoji(in.Emoji) {
		badRequest(w, r, "A reaction is one emoji.")
		return
	}
	call, ok := h.accessibleCall(w, r, id, p)
	if !ok {
		return
	}
	in_, err := h.Queries.InCall(r.Context(), store.InCallParams{CallID: call.ID, UserID: p.User.ID})
	if err != nil {
		h.callError(w, r, err)
		return
	}
	if !in_ || call.EndedAt.Valid {
		notInCall(w, r)
		return
	}
	user := uuid(p.User.ID).String()
	n, _, err := h.Limiter.Hit(r.Context(), "cenacle:call-reaction:"+uuid(call.ID).String()+":"+user, CallReactionInterval)
	if err != nil {
		h.unavailable(w, r, "call reaction rate limit", err)
		return
	}
	if n > 1 {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusTooManyRequests, Code: httpx.CodeRateLimited,
			Detail: "One reaction a second."})
		return
	}
	if h.Ephemeral != nil {
		if err := h.Ephemeral.Publish(r.Context(), events.CallReaction, CallReactionEvent{
			CallID: uuid(call.ID).String(), ChannelID: uuid(call.ChannelID).String(), UserID: user, Emoji: in.Emoji,
		}); err != nil {
			h.Log.WarnContext(r.Context(), "publish call reaction", "error", err)
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

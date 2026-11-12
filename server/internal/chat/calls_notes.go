// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"net/http"
	"strings"

	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/auth"
	"github.com/Cenacle-TR/cenacle/server/internal/events"
	"github.com/Cenacle-TR/cenacle/server/internal/httpx"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

// SetCallNotes implements api.ServerInterface.
func (h *Handlers) SetCallNotes(w http.ResponseWriter, r *http.Request, id openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.SetCallNotesJSONBody
	if !decode(w, r, &in) {
		return
	}
	call, ok := h.accessibleCall(w, r, id, p)
	if !ok {
		return
	}
	if in.On {
		allowed, err := h.Queries.CallCaptionsAllowed(r.Context(), call.ID)
		if err != nil {
			h.callError(w, r, err)
			return
		}
		if !allowed.CallsNotes || !allowed.CallsCaptions || !h.captionsAvailable() {
			forbidden(w, r, "notes_unavailable", "Call notes are not allowed in this workspace.")
			return
		}
	}
	inCall, err := h.Queries.InCall(r.Context(), store.InCallParams{CallID: call.ID, UserID: p.User.ID})
	if err != nil {
		h.callError(w, r, err)
		return
	}
	if !inCall || call.EndedAt.Valid {
		notInCall(w, r)
		return
	}
	err = h.inTx(r.Context(), func(q *store.Queries) error {
		changed, e := q.SetCallNotes(r.Context(), store.SetCallNotesParams{NotesOn: in.On, UserID: p.User.ID, ID: call.ID})
		if e != nil {
			return e
		}
		return emitCall(r.Context(), q, changed, events.CallParticipants)
	})
	if err != nil {
		h.callError(w, r, err)
		return
	}
	if c, err := h.Queries.GetChannel(r.Context(), call.ChannelID); err == nil {
		h.record(r, c.WorkspaceID, "call.notes_changed", "call", uuid(call.ID).String(), map[string]any{"on": in.On})
	}
	w.WriteHeader(http.StatusNoContent)
}

type callNoteLine struct {
	UserID *openapi_types.UUID `json:"user_id"`
	Text   string              `json:"text"`
	SaidAt string              `json:"said_at"`
}

func (h *Handlers) callNotes(w http.ResponseWriter, r *http.Request, id openapi_types.UUID) (store.Call, []callNoteLine, bool) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return store.Call{}, nil, false
	}
	call, ok := h.accessibleCall(w, r, id, p)
	if !ok {
		return store.Call{}, nil, false
	}
	rows, err := h.Queries.ListCallNotes(r.Context(), call.ID)
	if err != nil {
		h.callError(w, r, err)
		return store.Call{}, nil, false
	}
	out := make([]callNoteLine, 0, len(rows))
	for _, n := range rows {
		line := callNoteLine{Text: n.Text, SaidAt: n.SaidAt.UTC().Format("2006-01-02T15:04:05Z07:00")}
		if n.UserID.Valid {
			u := uuid(n.UserID)
			line.UserID = &u
		}
		out = append(out, line)
	}
	return call, out, true
}

// GetCallNotes implements api.ServerInterface.
func (h *Handlers) GetCallNotes(w http.ResponseWriter, r *http.Request, id openapi_types.UUID) {
	if _, lines, ok := h.callNotes(w, r, id); ok {
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"lines": lines})
	}
}

// SummarizeCallNotes implements api.ServerInterface.
func (h *Handlers) SummarizeCallNotes(w http.ResponseWriter, r *http.Request, id openapi_types.UUID, params api.SummarizeCallNotesParams) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	call, lines, ok := h.callNotes(w, r, id)
	if !ok {
		return
	}
	channel, err := h.Queries.GetChannel(r.Context(), call.ChannelID)
	if err != nil {
		h.callError(w, r, err)
		return
	}
	if !h.aiFor(w, r, channel.WorkspaceID, p.User) {
		return
	}
	if len(lines) == 0 {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "This call kept no notes."})
		return
	}
	names := map[openapi_types.UUID]string{}
	var input strings.Builder
	for _, l := range lines {
		name := "Someone"
		if l.UserID != nil {
			if _, ok := names[*l.UserID]; !ok {
				if u, err := h.Queries.GetUser(r.Context(), pgUUID(*l.UserID)); err == nil {
					names[*l.UserID] = u.DisplayName
				}
			}
			if n := names[*l.UserID]; n != "" {
				name = n
			}
		}
		input.WriteString(name + ": " + l.Text + "\n")
		if input.Len() > 60_000 {
			break
		}
	}
	system := "You summarise a meeting from its transcript (written out by speech recognition, so it may contain mistakes). " +
		"Write in " + answerLanguage(params.Language) + ". Give: a two-sentence overview, the decisions, the action items " +
		"with who owns them, and open questions. Use Markdown lists. Do not invent anything that is not in the transcript."
	text, ok := h.complete(w, r, channel.WorkspaceID, p.User, "summary", system, input.String())
	if !ok {
		return
	}
	httpx.WriteJSON(w, http.StatusOK, api.AIAnswer{Text: text, Sources: []api.AISource{}})
}

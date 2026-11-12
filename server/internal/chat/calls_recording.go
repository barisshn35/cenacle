// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"net/http"

	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/auth"
	"github.com/Cenacle-TR/cenacle/server/internal/events"
	"github.com/Cenacle-TR/cenacle/server/internal/httpx"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

// SetCallRecording implements api.ServerInterface. One person records at a
// time; anyone in the call may stop it (everyone sees it either way).
func (h *Handlers) SetCallRecording(w http.ResponseWriter, r *http.Request, id openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.SetCallRecordingJSONBody
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
		if !allowed.CallsRecording {
			forbidden(w, r, "recording_unavailable", "Calls are not recorded in this workspace.")
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
	changed := false
	err = h.inTx(r.Context(), func(q *store.Queries) error {
		c, e := q.SetCallRecording(r.Context(), store.SetCallRecordingParams{RecordingOn: in.On, UserID: p.User.ID, ID: call.ID})
		if isNoRows(e) {
			return nil
		}
		if e != nil {
			return e
		}
		changed = true
		return emitCall(r.Context(), q, c, events.CallParticipants)
	})
	if err != nil {
		h.callError(w, r, err)
		return
	}
	if !changed && in.On {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: "already_recording",
			Detail: "Someone already records this call."})
		return
	}
	if changed {
		if c, err := h.Queries.GetChannel(r.Context(), call.ChannelID); err == nil {
			h.record(r, c.WorkspaceID, "call.recording_changed", "call", uuid(call.ID).String(), map[string]any{"on": in.On})
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

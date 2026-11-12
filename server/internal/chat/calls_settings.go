// SPDX-License-Identifier: AGPL-3.0-only
package chat

import (
	"net/http"

	"github.com/Cenacle-TR/cenacle/server/internal/media"

	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/Cenacle-TR/cenacle/server/internal/auth"
	"github.com/Cenacle-TR/cenacle/server/internal/httpx"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

type callSettingsInput struct {
	Enabled         bool  `json:"enabled"`
	GuestStart      bool  `json:"guest_start"`
	MaxParticipants int32 `json:"max_participants"`
	MaxBitrate      int32 `json:"max_bitrate"`
	// Captions, Notes: nil keeps them (clients before live captions).
	Captions *bool `json:"captions"`
	Notes    *bool `json:"notes"`
	// Recording: nil keeps it.
	Recording *bool `json:"recording"`
}

func (h *Handlers) GetWorkspaceCallSettings(w http.ResponseWriter, r *http.Request, id openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	if _, ok = h.workspaceRole(w, r, id, p.User); !ok {
		return
	}
	settings, err := h.Queries.GetCallSettings(r.Context(), pgUUID(id))
	if err != nil {
		h.callError(w, r, err)
		return
	}
	httpx.WriteJSON(w, 200, map[string]any{"enabled": settings.CallsEnabled, "guest_start": settings.CallsGuestStart, "max_participants": settings.CallsMaxParticipants, "max_bitrate": settings.CallsMaxBitrate, "available": h.Calls != nil,
		"captions": settings.CallsCaptions, "captions_available": h.captionsAvailable(), "notes": settings.CallsNotes, "recording": settings.CallsRecording})
}
func (h *Handlers) SetWorkspaceCallSettings(w http.ResponseWriter, r *http.Request, id openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !h.requireWorkspaceAdmin(w, r, id, p.User, "Only workspace administrators can change call settings.") {
		return
	}
	var in callSettingsInput
	if !decode(w, r, &in) {
		return
	}
	if in.MaxParticipants < 2 || in.MaxParticipants > media.MaxParticipantsCap || in.MaxBitrate < 64000 || in.MaxBitrate > 10000000 {
		badRequest(w, r, "Participant limit must be 2 to 8 and bitrate 64000 to 10000000.")
		return
	}
	if in.Enabled && h.Calls == nil {
		forbidden(w, r, "calls_disabled", "Calls are disabled on this installation.")
		return
	}
	current, err := h.Queries.GetCallSettings(r.Context(), pgUUID(id))
	if err != nil {
		h.callError(w, r, err)
		return
	}
	captions := current.CallsCaptions
	if in.Captions != nil {
		captions = *in.Captions
	}
	notes := current.CallsNotes
	if in.Notes != nil {
		notes = *in.Notes
	}
	notes = notes && captions // notes are what captions write
	recording := current.CallsRecording
	if in.Recording != nil {
		recording = *in.Recording
	}
	if captions && !current.CallsCaptions && !h.captionsAvailable() {
		forbidden(w, r, "captions_unavailable", "This installation has no speech to text service.")
		return
	}
	err = h.Queries.UpdateCallSettings(r.Context(), store.UpdateCallSettingsParams{WorkspaceID: pgUUID(id), CallsEnabled: in.Enabled, CallsGuestStart: in.GuestStart, CallsMaxParticipants: in.MaxParticipants, CallsMaxBitrate: in.MaxBitrate, CallsCaptions: captions, CallsNotes: notes, CallsRecording: recording})
	if err != nil {
		h.callError(w, r, err)
		return
	}
	h.record(r, pgUUID(id), "call.settings_changed", "workspace", id.String(), map[string]any{"enabled": in.Enabled, "guest_start": in.GuestStart, "max_participants": in.MaxParticipants, "max_bitrate": in.MaxBitrate, "captions": captions, "notes": notes, "recording": recording})
	h.GetWorkspaceCallSettings(w, r, id)
}

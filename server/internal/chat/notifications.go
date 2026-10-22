// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/auth"
	"github.com/barisshn35/cenacle/server/internal/httpx"
	"github.com/barisshn35/cenacle/server/internal/notify"
	"github.com/barisshn35/cenacle/server/internal/store"
)

// Sounds people upload.
const (
	MaxUserSounds    = 5
	MaxUserSoundSize = 1 << 20
	CodeSoundLimit   = "sound_limit"
	CodeNotSound     = "not_a_sound"
)

func timePtr(t pgtype.Timestamptz) *time.Time {
	if !t.Valid {
		return nil
	}
	v := t.Time
	return &v
}

func (h *Handlers) notificationSettings(r *http.Request, user pgtype.UUID) (api.NotificationSettings, error) {
	ctx := r.Context()
	raw, err := h.Queries.GetNotificationPrefs(ctx, user)
	if err != nil {
		return api.NotificationSettings{}, err
	}
	var prefs api.NotificationPrefs
	// Same JSON shape: the defaults filled in by package notify.
	b, _ := json.Marshal(notify.Read(raw))
	_ = json.Unmarshal(b, &prefs)
	chans, err := h.Queries.ListChannelNotificationPrefs(ctx, user)
	if err != nil {
		return api.NotificationSettings{}, err
	}
	wss, err := h.Queries.ListWorkspaceNotificationPrefs(ctx, user)
	if err != nil {
		return api.NotificationSettings{}, err
	}
	out := api.NotificationSettings{
		Prefs: prefs, EmailAvailable: h.EmailAvailable,
		Channels:   make([]api.ChannelNotification, 0, len(chans)),
		Workspaces: make([]api.WorkspaceNotification, 0, len(wss)),
	}
	for _, c := range chans {
		out.Channels = append(out.Channels, api.ChannelNotification{
			ChannelId: uuid(c.ChannelID), Level: api.ChannelNotificationLevel(c.Level),
			MutedUntil: timePtr(c.MutedUntil), Sound: c.Sound,
		})
	}
	for _, w := range wss {
		out.Workspaces = append(out.Workspaces, api.WorkspaceNotification{WorkspaceId: uuid(w.WorkspaceID), MutedUntil: timePtr(w.MutedUntil)})
	}
	if h.PushPublicKey != nil {
		if key, err := h.PushPublicKey(ctx); err == nil && key != "" {
			out.PushPublicKey = &key
		}
	}
	return out, nil
}

// GetNotificationSettings implements api.ServerInterface.
func (h *Handlers) GetNotificationSettings(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	out, err := h.notificationSettings(r, p.User.ID)
	if err != nil {
		h.unavailable(w, r, "notification settings", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// SetNotificationPrefs implements api.ServerInterface.
func (h *Handlers) SetNotificationPrefs(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in notify.Prefs
	if !decode(w, r, &in) {
		return
	}
	if !in.Valid() {
		badRequest(w, r, "Some notification settings are not known values.")
		return
	}
	raw, _ := json.Marshal(in)
	if err := h.Queries.SetNotificationPrefs(r.Context(), store.SetNotificationPrefsParams{UserID: p.User.ID, Prefs: raw}); err != nil {
		h.unavailable(w, r, "set notification prefs", err)
		return
	}
	h.GetNotificationSettings(w, r)
}

// SetChannelNotifications implements api.ServerInterface.
func (h *Handlers) SetChannelNotifications(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.ChannelNotificationInput
	if !decode(w, r, &in) {
		return
	}
	if !in.Level.Valid() || len(in.Sound) > 64 || (in.Sound != "" && !notify.ValidSound(in.Sound)) {
		badRequest(w, r, "Choose a known level and sound.")
		return
	}
	if _, _, ok := h.memberChannel(w, r, channelID, p.User); !ok {
		return
	}
	params := store.SetChannelNotificationPrefsParams{UserID: p.User.ID, ChannelID: pgUUID(channelID), Level: string(in.Level), Sound: in.Sound}
	if in.MutedUntil != nil {
		params.MutedUntil = pgtype.Timestamptz{Time: *in.MutedUntil, Valid: true}
	}
	if err := h.Queries.SetChannelNotificationPrefs(r.Context(), params); err != nil {
		h.unavailable(w, r, "set channel notifications", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, api.ChannelNotification{
		ChannelId: channelID, Level: api.ChannelNotificationLevel(in.Level), MutedUntil: in.MutedUntil, Sound: in.Sound,
	})
}

// SetWorkspaceNotifications implements api.ServerInterface.
func (h *Handlers) SetWorkspaceNotifications(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.SetWorkspaceNotificationsJSONBody
	if !decode(w, r, &in) {
		return
	}
	if _, ok := h.workspaceRole(w, r, workspaceID, p.User); !ok {
		return
	}
	params := store.SetWorkspaceNotificationPrefsParams{UserID: p.User.ID, WorkspaceID: pgUUID(workspaceID)}
	if in.MutedUntil != nil {
		params.MutedUntil = pgtype.Timestamptz{Time: *in.MutedUntil, Valid: true}
	}
	if err := h.Queries.SetWorkspaceNotificationPrefs(r.Context(), params); err != nil {
		h.unavailable(w, r, "set workspace notifications", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, api.WorkspaceNotification{WorkspaceId: workspaceID, MutedUntil: in.MutedUntil})
}

// soundType recognises an audio file by its first bytes.
func soundType(data []byte) string {
	switch {
	case bytes.HasPrefix(data, []byte("ID3")), len(data) > 1 && data[0] == 0xff && data[1]&0xe0 == 0xe0:
		return "audio/mpeg"
	case bytes.HasPrefix(data, []byte("OggS")):
		return "audio/ogg"
	case bytes.HasPrefix(data, []byte("RIFF")) && len(data) > 12 && string(data[8:12]) == "WAVE":
		return "audio/wav"
	case bytes.HasPrefix(data, []byte{0x1a, 0x45, 0xdf, 0xa3}):
		return "audio/webm"
	}
	return ""
}

// ListMySounds implements api.ServerInterface.
func (h *Handlers) ListMySounds(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	rows, err := h.Queries.ListUserSounds(r.Context(), p.User.ID)
	if err != nil {
		h.unavailable(w, r, "list sounds", err)
		return
	}
	out := make([]api.UserSound, 0, len(rows))
	for _, s := range rows {
		out = append(out, api.UserSound{Id: uuid(s.ID), Name: s.Name, ContentType: s.ContentType, Size: int(s.Size), CreatedAt: s.CreatedAt})
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"sounds": out})
}

// UploadSound implements api.ServerInterface.
func (h *Handlers) UploadSound(w http.ResponseWriter, r *http.Request, params api.UploadSoundParams) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	name := strings.Join(strings.Fields(params.Name), " ")
	if name == "" || len([]rune(name)) > 60 {
		badRequest(w, r, "Name the sound (up to 60 characters).")
		return
	}
	ctx := r.Context()
	n, err := h.Queries.CountUserSounds(ctx, p.User.ID)
	if err != nil {
		h.unavailable(w, r, "count sounds", err)
		return
	}
	if n >= MaxUserSounds {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeSoundLimit, Detail: "You have five sounds; remove one first."})
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxUserSoundSize))
	if err != nil {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusRequestEntityTooLarge, Code: httpx.CodeBadRequest, Detail: "Sounds may be up to 1 MB."})
		return
	}
	ct := soundType(data)
	if ct == "" {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusUnprocessableEntity, Code: CodeNotSound, Detail: "Use MP3, Ogg, WAV or WebM audio."})
		return
	}
	s, err := h.Queries.InsertUserSound(ctx, store.InsertUserSoundParams{UserID: p.User.ID, Name: name, ContentType: ct, Data: data})
	if err != nil {
		h.unavailable(w, r, "insert sound", err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, api.UserSound{Id: uuid(s.ID), Name: s.Name, ContentType: s.ContentType, Size: int(s.Size), CreatedAt: s.CreatedAt})
}

// DeleteSound implements api.ServerInterface.
func (h *Handlers) DeleteSound(w http.ResponseWriter, r *http.Request, soundID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	n, err := h.Queries.DeleteUserSound(r.Context(), store.DeleteUserSoundParams{ID: pgUUID(soundID), UserID: p.User.ID})
	if err != nil {
		h.unavailable(w, r, "delete sound", err)
		return
	}
	if n == 0 {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// GetSound implements api.ServerInterface.
func (h *Handlers) GetSound(w http.ResponseWriter, r *http.Request, soundID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	s, err := h.Queries.GetUserSound(r.Context(), pgUUID(soundID))
	if err != nil || s.UserID != p.User.ID {
		if err == nil || isNoRows(err) {
			httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound})
			return
		}
		h.unavailable(w, r, "get sound", err)
		return
	}
	hdr := w.Header()
	hdr.Set("Content-Type", s.ContentType)
	hdr.Set("X-Content-Type-Options", "nosniff")
	hdr.Set("Content-Security-Policy", "sandbox; default-src 'none'")
	hdr.Set("Cache-Control", "private, max-age=31536000, immutable")
	_, _ = w.Write(s.Data)
}

// AddPushSubscription implements api.ServerInterface.
func (h *Handlers) AddPushSubscription(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	if h.PushPublicKey == nil {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "Web push is off on this installation."})
		return
	}
	var in api.PushSubscription
	if !decode(w, r, &in) {
		return
	}
	// Push services are https endpoints of the browser makers; nothing else is accepted.
	u, err := url.Parse(in.Endpoint)
	if err != nil || u.Scheme != "https" || u.Host == "" || in.Keys.P256dh == "" || in.Keys.Auth == "" {
		badRequest(w, r, "A push subscription has an https endpoint and its keys.")
		return
	}
	ctx := r.Context()
	if n, err := h.Queries.CountPushSubscriptions(ctx, p.User.ID); err != nil {
		h.unavailable(w, r, "count push subscriptions", err)
		return
	} else if n >= 20 {
		badRequest(w, r, "Too many browsers receive push; remove some first.")
		return
	}
	if err := h.Queries.AddPushSubscription(ctx, store.AddPushSubscriptionParams{
		UserID: p.User.ID, Endpoint: in.Endpoint, P256dh: in.Keys.P256dh, Auth: in.Keys.Auth,
	}); err != nil {
		h.unavailable(w, r, "add push subscription", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// RemovePushSubscription implements api.ServerInterface.
func (h *Handlers) RemovePushSubscription(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.RemovePushSubscriptionJSONBody
	if !decode(w, r, &in) {
		return
	}
	if err := h.Queries.RemovePushSubscription(r.Context(), store.RemovePushSubscriptionParams{Endpoint: in.Endpoint, UserID: p.User.ID}); err != nil {
		h.unavailable(w, r, "remove push subscription", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

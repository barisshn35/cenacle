// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
	_ "time/tzdata" // time zones without the system's database (distroless images)
	"unicode"

	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/auth"
	"github.com/barisshn35/cenacle/server/internal/events"
	"github.com/barisshn35/cenacle/server/internal/httpx"
	"github.com/barisshn35/cenacle/server/internal/preview"
	"github.com/barisshn35/cenacle/server/internal/profiles"
	"github.com/barisshn35/cenacle/server/internal/store"
)

// Problem codes of profiles.
const (
	CodeUsernameTaken   = "username_taken"
	CodeUsernameManaged = "username_managed"
	CodeNotPicture      = "not_a_picture"
)

var usernamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{1,29}$`)

// reservedUsernames are words mentions use for groups of people.
var reservedUsernames = map[string]bool{"all": true, "here": true, "channel": true, "everyone": true}

// maxStatusDuration bounds how long a custom status may be set for.
const maxStatusDuration = 366 * 24 * time.Hour

func pictureURL(id pgtype.UUID, still bool) *string {
	if !id.Valid {
		return nil
	}
	u := "/api/pictures/" + uuid(id).String()
	if still {
		u += "?still=true"
	}
	return &u
}

func profileAPI(row store.GetProfilesRow) api.Profile {
	p := api.Profile{
		Id: uuid(row.ID), DisplayName: row.DisplayName, Username: row.Username.String,
		Email: row.Email, IsBot: row.IsBot, Timezone: row.Timezone,
		AvatarUrl:   pictureURL(row.AvatarID, false),
		Deactivated: row.DeactivatedAt.Valid, Guest: row.DirectoryRole.String == "guest",
	}
	if row.AvatarAnimated {
		p.AvatarStillUrl = pictureURL(row.AvatarID, true)
	}
	if row.StatusEmoji != "" || row.StatusText != "" {
		s := api.CustomStatus{Emoji: row.StatusEmoji, Text: row.StatusText}
		if row.StatusExpiresAt.Valid {
			s.ExpiresAt = &row.StatusExpiresAt.Time
		}
		p.Status = &s
	}
	if row.ShowLastSeen && row.LastSeenAt.Valid {
		p.LastSeenAt = &row.LastSeenAt.Time
	}
	return p
}

// GetProfiles implements api.ServerInterface.
func (h *Handlers) GetProfiles(w http.ResponseWriter, r *http.Request, params api.GetProfilesParams) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	if len(params.Ids) == 0 || len(params.Ids) > 100 {
		badRequest(w, r, "Ask for 1 to 100 people.")
		return
	}
	ids := make([]pgtype.UUID, len(params.Ids))
	for i, id := range params.Ids {
		ids[i] = pgUUID(id)
	}
	visible, err := h.Queries.VisibleProfileIDs(r.Context(), store.VisibleProfileIDsParams{Ids: ids, Viewer: p.User.ID})
	if err != nil {
		h.unavailable(w, r, "visible profiles", err)
		return
	}
	rows, err := h.Queries.GetProfiles(r.Context(), visible)
	if err != nil {
		h.unavailable(w, r, "get profiles", err)
		return
	}
	out := make([]api.Profile, 0, len(rows))
	for _, row := range rows {
		out = append(out, profileAPI(row))
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"profiles": out})
}

func (h *Handlers) myProfile(ctx context.Context, user pgtype.UUID) (api.MyProfile, error) {
	if err := h.Queries.AssignUsername(ctx, user); err != nil {
		return api.MyProfile{}, err
	}
	rows, err := h.Queries.GetProfiles(ctx, []pgtype.UUID{user})
	if err != nil {
		return api.MyProfile{}, err
	}
	if len(rows) == 0 {
		return api.MyProfile{}, errors.New("profile: no such user")
	}
	row := rows[0]
	pr := profileAPI(row)
	if row.LastSeenAt.Valid {
		pr.LastSeenAt = &row.LastSeenAt.Time // your own, even when hidden from others
	}
	recent := []api.CustomStatus{}
	_ = json.Unmarshal(row.RecentStatuses, &recent)
	return api.MyProfile{
		Id: pr.Id, DisplayName: pr.DisplayName, Username: pr.Username, Email: pr.Email,
		IsBot: pr.IsBot, AvatarUrl: pr.AvatarUrl, AvatarStillUrl: pr.AvatarStillUrl,
		Timezone: pr.Timezone, Status: pr.Status, LastSeenAt: pr.LastSeenAt,
		Deactivated: pr.Deactivated, Guest: pr.Guest,
		UsernameEditable:  !row.UsernameFromDirectory,
		ShowLastSeen:      row.ShowLastSeen,
		ShareReadReceipts: ptr(row.ShareReadReceipts),
		RecentStatuses:    recent,
		AccountUrl:        h.AccountURL,
	}, nil
}

func (h *Handlers) writeMyProfile(w http.ResponseWriter, r *http.Request, user pgtype.UUID) {
	me, err := h.myProfile(r.Context(), user)
	if err != nil {
		h.unavailable(w, r, "my profile", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, me)
}

// userUpdated tells the people of the user's workspaces (and the user's other
// devices) that the profile changed.
func (h *Handlers) userUpdated(ctx context.Context, user pgtype.UUID) {
	if err := profiles.Updated(ctx, h.Queries, user); err != nil {
		h.Log.ErrorContext(ctx, "append event", "type", events.UserUpdated, "error", err)
	}
}

// GetMyProfile implements api.ServerInterface.
func (h *Handlers) GetMyProfile(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	h.writeMyProfile(w, r, p.User.ID)
}

// UpdateMyProfile implements api.ServerInterface.
func (h *Handlers) UpdateMyProfile(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.UpdateMyProfileJSONBody
	if !decode(w, r, &in) {
		return
	}
	ctx := r.Context()
	params := store.UpdateProfileSettingsParams{ID: p.User.ID}
	if in.Username != nil {
		name := strings.ToLower(strings.TrimSpace(*in.Username))
		if !usernamePattern.MatchString(name) || reservedUsernames[name] {
			badRequest(w, r, "A username has 2 to 30 letters a-z, digits, dots, dashes or underscores, and is not all, here, channel or everyone.")
			return
		}
		rows, err := h.Queries.GetProfiles(ctx, []pgtype.UUID{p.User.ID})
		if err != nil || len(rows) == 0 {
			h.unavailable(w, r, "get profile", err)
			return
		}
		if rows[0].UsernameFromDirectory {
			forbidden(w, r, CodeUsernameManaged, "Your username is your sign-in name in the directory.")
			return
		}
		taken, err := h.Queries.UsernameTaken(ctx, store.UsernameTakenParams{Username: name, ID: p.User.ID})
		if err != nil {
			h.unavailable(w, r, "username taken", err)
			return
		}
		if taken {
			httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeUsernameTaken,
				Detail: "Someone else has this username."})
			return
		}
		params.Username = pgtype.Text{String: name, Valid: true}
	}
	if in.Timezone != nil {
		tz := strings.TrimSpace(*in.Timezone)
		if tz != "" {
			if _, err := time.LoadLocation(tz); err != nil || tz == "Local" {
				badRequest(w, r, "Unknown time zone; use an IANA name such as Europe/Istanbul.")
				return
			}
		}
		params.Timezone = pgtype.Text{String: tz, Valid: true}
	}
	if in.ShowLastSeen != nil {
		params.ShowLastSeen = pgtype.Bool{Bool: *in.ShowLastSeen, Valid: true}
	}
	if in.ShareReadReceipts != nil {
		params.ShareReadReceipts = pgtype.Bool{Bool: *in.ShareReadReceipts, Valid: true}
	}
	if err := h.Queries.UpdateProfileSettings(ctx, params); err != nil {
		if isUniqueViolation(err) {
			httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeUsernameTaken,
				Detail: "Someone else has this username."})
			return
		}
		h.unavailable(w, r, "update profile", err)
		return
	}
	h.userUpdated(ctx, p.User.ID)
	h.writeMyProfile(w, r, p.User.ID)
}

// cleanStatus checks a custom status: an emoji (one grapheme cluster, no
// letters or digits) and/or a text, ending in the future.
func cleanStatus(in api.CustomStatus, now time.Time) (api.CustomStatus, bool) {
	emoji := strings.TrimSpace(in.Emoji)
	text := strings.Join(strings.Fields(in.Text), " ")
	if emoji == "" && text == "" {
		return in, false
	}
	if len([]rune(emoji)) > 16 || len([]rune(text)) > 100 {
		return in, false
	}
	for _, c := range emoji {
		if unicode.IsLetter(c) || unicode.IsDigit(c) || unicode.IsSpace(c) || unicode.IsControl(c) {
			return in, false
		}
	}
	for _, c := range text {
		if unicode.IsControl(c) {
			return in, false
		}
	}
	out := api.CustomStatus{Emoji: emoji, Text: text}
	if in.ExpiresAt != nil {
		if !in.ExpiresAt.After(now) || in.ExpiresAt.Sub(now) > maxStatusDuration {
			return in, false
		}
		at := in.ExpiresAt.UTC()
		out.ExpiresAt = &at
	}
	return out, true
}

// SetCustomStatus implements api.ServerInterface.
func (h *Handlers) SetCustomStatus(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.CustomStatus
	if !decode(w, r, &in) {
		return
	}
	st, valid := cleanStatus(in, time.Now())
	if !valid {
		badRequest(w, r, "A status has an emoji, a text of up to 100 characters or both, and ends in the future (within a year).")
		return
	}
	params := store.SetCustomStatusParams{ID: p.User.ID, Emoji: st.Emoji, Text: st.Text}
	if st.ExpiresAt != nil {
		params.ExpiresAt = pgtype.Timestamptz{Time: *st.ExpiresAt, Valid: true}
	}
	if err := h.Queries.SetCustomStatus(r.Context(), params); err != nil {
		h.unavailable(w, r, "set status", err)
		return
	}
	h.userUpdated(r.Context(), p.User.ID)
	h.writeMyProfile(w, r, p.User.ID)
}

// ClearCustomStatus implements api.ServerInterface.
func (h *Handlers) ClearCustomStatus(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	if err := h.Queries.ClearCustomStatus(r.Context(), p.User.ID); err != nil {
		h.unavailable(w, r, "clear status", err)
		return
	}
	h.userUpdated(r.Context(), p.User.ID)
	w.WriteHeader(http.StatusNoContent)
}

// readPicture reads an uploaded image and makes a picture of it; it answers
// the request itself when that fails.
func readPicture(w http.ResponseWriter, r *http.Request) (preview.Picture, bool) {
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, preview.MaxUpload))
	if err != nil {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusRequestEntityTooLarge, Code: httpx.CodeBadRequest,
			Detail: "Pictures may be up to 5 MB."})
		return preview.Picture{}, false
	}
	pic, err := preview.MakePicture(r.Context(), data)
	if err != nil {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusUnprocessableEntity, Code: CodeNotPicture,
			Detail: "Use a PNG, JPEG, GIF or WebP image of at most 5 MB and a usual size (an animated GIF of at most 2 MB and 1024 pixels)."})
		return preview.Picture{}, false
	}
	return pic, true
}

func (h *Handlers) insertPicture(ctx context.Context, q store.Querier, pic preview.Picture) (pgtype.UUID, error) {
	return q.InsertPicture(ctx, store.InsertPictureParams{ContentType: pic.ContentType, Data: pic.Data, Still: pic.Still})
}

// SetAvatar implements api.ServerInterface.
func (h *Handlers) SetAvatar(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	pic, ok := readPicture(w, r)
	if !ok {
		return
	}
	if err := profiles.ReplaceAvatar(r.Context(), h.Queries, p.User.ID, &pic, false); err != nil {
		h.unavailable(w, r, "set avatar", err)
		return
	}
	h.userUpdated(r.Context(), p.User.ID)
	h.writeMyProfile(w, r, p.User.ID)
}

// DeleteAvatar implements api.ServerInterface.
func (h *Handlers) DeleteAvatar(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	if err := profiles.ReplaceAvatar(r.Context(), h.Queries, p.User.ID, nil, false); err != nil {
		h.unavailable(w, r, "delete avatar", err)
		return
	}
	h.userUpdated(r.Context(), p.User.ID)
	w.WriteHeader(http.StatusNoContent)
}

// GetPicture implements api.ServerInterface.
func (h *Handlers) GetPicture(w http.ResponseWriter, r *http.Request, pictureID openapi_types.UUID, params api.GetPictureParams) {
	if _, ok := auth.RequirePrincipal(w, r, h.Cookies); !ok {
		return
	}
	pic, err := h.Queries.GetPicture(r.Context(), pgUUID(pictureID))
	if err != nil {
		if isNoRows(err) {
			httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound})
			return
		}
		h.unavailable(w, r, "get picture", err)
		return
	}
	data, contentType := pic.Data, pic.ContentType
	if params.Still != nil && *params.Still && pic.Still != nil {
		data, contentType = pic.Still, "image/png"
	}
	hdr := w.Header()
	hdr.Set("Content-Type", contentType)
	hdr.Set("X-Content-Type-Options", "nosniff")
	hdr.Set("Content-Security-Policy", "sandbox; default-src 'none'")
	// A picture never changes: a new one has a new id.
	hdr.Set("Cache-Control", "private, max-age=31536000, immutable")
	_, _ = w.Write(data)
}

// SetWorkspaceIcon implements api.ServerInterface.
func (h *Handlers) SetWorkspaceIcon(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	h.changeWorkspaceIcon(w, r, workspaceID, true)
}

// DeleteWorkspaceIcon implements api.ServerInterface.
func (h *Handlers) DeleteWorkspaceIcon(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	h.changeWorkspaceIcon(w, r, workspaceID, false)
}

func (h *Handlers) changeWorkspaceIcon(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID, set bool) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	ws, role, ok := h.administeredWorkspace(w, r, workspaceID, p.User)
	if !ok {
		return
	}
	ctx := r.Context()
	var icon pgtype.UUID
	if set {
		pic, ok := readPicture(w, r)
		if !ok {
			return
		}
		// Icons do not move: the first frame of a GIF.
		if pic.Still != nil {
			pic = preview.Picture{Data: pic.Still, ContentType: "image/png"}
		}
		var err error
		if icon, err = h.insertPicture(ctx, h.Queries, pic); err != nil {
			h.unavailable(w, r, "insert icon", err)
			return
		}
	}
	old, err := h.Queries.SetWorkspaceIcon(ctx, store.SetWorkspaceIconParams{ID: ws.ID, IconID: icon})
	if err != nil {
		h.unavailable(w, r, "set icon", err)
		return
	}
	if old.Valid {
		_ = h.Queries.DeletePicture(ctx, old)
	}
	h.publish(ctx, events.WorkspaceUpdated, WorkspaceEvent{WorkspaceID: uuid(ws.ID).String()})
	if !set {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	ws.IconID = icon
	httpx.WriteJSON(w, http.StatusOK, workspaceAPI(ws, role))
}

// TidyProfiles implements jobs.Profiles: custom statuses whose time is up are
// cleared (and announced), and people without a @username get one.
func (b *Background) TidyProfiles(ctx context.Context) (int, error) {
	ids, err := b.Queries.ClearExpiredStatuses(ctx)
	if err != nil {
		return 0, err
	}
	for _, id := range ids {
		if err := profiles.Updated(ctx, b.Queries, id); err != nil {
			return len(ids), err
		}
	}
	without, err := b.Queries.UsersWithoutUsername(ctx)
	if err != nil {
		return len(ids), err
	}
	for _, id := range without {
		if err := b.Queries.AssignUsername(ctx, id); err != nil {
			return len(ids), err
		}
		if err := profiles.Updated(ctx, b.Queries, id); err != nil {
			return len(ids), err
		}
	}
	return len(ids) + len(without), nil
}

// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/audit"
	"github.com/Cenacle-TR/cenacle/server/internal/auth"
	"github.com/Cenacle-TR/cenacle/server/internal/events"
	"github.com/Cenacle-TR/cenacle/server/internal/httpx"
	"github.com/Cenacle-TR/cenacle/server/internal/notify"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

// configValue shows a setting as text.
func configValue(v any) string {
	switch x := v.(type) {
	case []string:
		return strings.Join(x, ", ")
	case string:
		return x
	default:
		return fmt.Sprint(x)
	}
}

// AdminOverview implements api.ServerInterface.
func (h *Handlers) AdminOverview(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !requireInstanceAdmin(w, r, p) {
		return
	}
	ctx := r.Context()
	counts, err := h.Queries.InstanceCounts(ctx)
	if err != nil {
		h.unavailable(w, r, "counts", err)
		return
	}
	active, err := h.Queries.ActiveUserCount(ctx)
	if err != nil {
		h.unavailable(w, r, "active users", err)
		return
	}
	out := api.AdminOverview{Version: h.Version, Config: []struct {
		Name  string `json:"name"`
		Value string `json:"value"`
	}{}}
	out.Counts.Users, out.Counts.ActiveUsers, out.Counts.Bots = counts.People, active, counts.Bots
	out.Counts.Workspaces, out.Counts.Channels, out.Counts.Messages = counts.Workspaces, counts.Channels, counts.Messages
	out.Counts.Files, out.Counts.FileBytes = counts.Files, counts.FileBytes
	names := make([]string, 0, len(h.Settings))
	for name := range h.Settings {
		names = append(names, name)
	}
	slices.Sort(names)
	for _, name := range names {
		out.Config = append(out.Config, struct {
			Name  string `json:"name"`
			Value string `json:"value"`
		}{name, configValue(h.Settings[name])})
	}
	jobs, failures, err := h.jobStates(ctx)
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "42P01" {
		// No job tables (River's migrations have not run): nothing to show.
		jobs, failures, err = []jobRow{}, []failureRow{}, nil
	}
	if err != nil {
		h.unavailable(w, r, "jobs", err)
		return
	}
	out.Jobs, out.Failures = jobs, failures
	apps, err := h.Queries.DesktopAppVersions(ctx)
	if err != nil {
		h.unavailable(w, r, "desktop apps", err)
		return
	}
	out.DesktopApps = make([]desktopApp, len(apps))
	for i, a := range apps {
		out.DesktopApps[i] = desktopApp{Version: a.Version, Platform: platformOf(a.Platform), Devices: a.Devices}
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

type jobRow = struct {
	Available int    `json:"available"`
	Completed int    `json:"completed"`
	Discarded int    `json:"discarded"`
	Kind      string `json:"kind"`
	Retryable int    `json:"retryable"`
	Running   int    `json:"running"`
}

type failureRow = struct {
	At      time.Time `json:"at"`
	Attempt int       `json:"attempt"`
	Error   string    `json:"error"`
	Kind    string    `json:"kind"`
	State   string    `json:"state"`
}

// jobStates reads River's job table: counts by kind and state, and the
// latest failed attempts.
func (h *Handlers) jobStates(ctx context.Context) ([]jobRow, []failureRow, error) {
	jobs := []jobRow{}
	failures := []failureRow{}
	tx, err := h.DB.Begin(ctx)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `SELECT kind, state::text, count(*) FROM river_job
		WHERE state <> 'completed' OR finalized_at > now() - interval '1 day'
		GROUP BY kind, state ORDER BY kind`)
	if err != nil {
		return nil, nil, err
	}
	byKind := map[string]*jobRow{}
	var order []string
	for rows.Next() {
		var kind, state string
		var n int
		if err := rows.Scan(&kind, &state, &n); err != nil {
			rows.Close()
			return nil, nil, err
		}
		row, ok := byKind[kind]
		if !ok {
			row = &jobRow{Kind: kind}
			byKind[kind] = row
			order = append(order, kind)
		}
		switch state {
		case "available", "scheduled", "pending":
			row.Available += n
		case "running":
			row.Running += n
		case "retryable":
			row.Retryable += n
		case "discarded", "cancelled":
			row.Discarded += n
		case "completed":
			row.Completed += n
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	for _, k := range order {
		jobs = append(jobs, *byKind[k])
	}
	rows, err = tx.Query(ctx, `SELECT kind, state::text, attempt,
			coalesce(errors[array_length(errors, 1)]->>'error', ''),
			coalesce((errors[array_length(errors, 1)]->>'at')::timestamptz, attempted_at, created_at)
		FROM river_job WHERE state IN ('retryable', 'discarded') AND errors IS NOT NULL
		ORDER BY id DESC LIMIT 20`)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var f failureRow
		if err := rows.Scan(&f.Kind, &f.State, &f.Attempt, &f.Error, &f.At); err != nil {
			return nil, nil, err
		}
		if len(f.Error) > 500 {
			f.Error = f.Error[:500]
		}
		failures = append(failures, f)
	}
	return jobs, failures, rows.Err()
}

// AdminListUsers implements api.ServerInterface.
func (h *Handlers) AdminListUsers(w http.ResponseWriter, r *http.Request, params api.AdminListUsersParams) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !requireInstanceAdmin(w, r, p) {
		return
	}
	arg := store.AdminListUsersParams{Q: strings.TrimSpace(deref1(params.Q))}
	if params.AfterName != nil && params.AfterId != nil {
		arg.AfterName = pgtype.Text{String: strings.ToLower(*params.AfterName), Valid: true}
		arg.AfterID = pgUUID(*params.AfterId)
	}
	rows, err := h.Queries.AdminListUsers(r.Context(), arg)
	if err != nil {
		h.unavailable(w, r, "list users", err)
		return
	}
	out := struct {
		Users []api.AdminUser `json:"users"`
		Next  *struct {
			AfterName string             `json:"after_name"`
			AfterID   openapi_types.UUID `json:"after_id"`
		} `json:"next,omitempty"`
	}{Users: make([]api.AdminUser, 0, len(rows))}
	for _, u := range rows {
		// last_seen_at is written on going offline; a later sign-in is newer.
		seen := u.LastSeenAt
		if u.LastLoginAt.Valid && (!seen.Valid || u.LastLoginAt.Time.After(seen.Time)) {
			seen = u.LastLoginAt
		}
		out.Users = append(out.Users, api.AdminUser{
			Id: uuid(u.ID), DisplayName: u.DisplayName, Email: u.Email, Username: u.Username, IsAdmin: u.IsAdmin,
			Guest: u.DirectoryRole == "guest", Deactivated: u.DeactivatedAt.Valid, LastSeenAt: timeOf(seen),
			Erased:    ptr(u.Erased),
			CreatedAt: u.CreatedAt, Workspaces: int(u.Workspaces), Sessions: int(u.Sessions),
		})
	}
	if len(rows) == 50 {
		last := rows[len(rows)-1]
		out.Next = &struct {
			AfterName string             `json:"after_name"`
			AfterID   openapi_types.UUID `json:"after_id"`
		}{last.DisplayName, uuid(last.ID)}
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// AdminEndUserSessions implements api.ServerInterface.
func (h *Handlers) AdminEndUserSessions(w http.ResponseWriter, r *http.Request, userID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !requireInstanceAdmin(w, r, p) {
		return
	}
	ctx := r.Context()
	if _, err := h.Queries.GetUser(ctx, pgUUID(userID)); isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No such person."})
		return
	} else if err != nil {
		h.unavailable(w, r, "get user", err)
		return
	}
	if _, err := h.Queries.DeleteOtherSessions(ctx, store.DeleteOtherSessionsParams{UserID: pgUUID(userID), Keep: pgtype.UUID{Valid: true}}); err != nil {
		h.unavailable(w, r, "end sessions", err)
		return
	}
	if h.Ephemeral != nil {
		_ = h.Ephemeral.Publish(ctx, events.SessionsEnded, map[string]string{"user_id": userID.String()})
	}
	h.record(r, pgtype.UUID{}, audit.SessionsEndedByAdmin, "user", userID.String(), nil)
	w.WriteHeader(http.StatusNoContent)
}

// AdminListWorkspaces implements api.ServerInterface.
func (h *Handlers) AdminListWorkspaces(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !requireInstanceAdmin(w, r, p) {
		return
	}
	rows, err := h.Queries.AdminListWorkspaces(r.Context())
	if err != nil {
		h.unavailable(w, r, "list workspaces", err)
		return
	}
	out := make([]api.AdminWorkspace, 0, len(rows))
	for _, ws := range rows {
		out = append(out, api.AdminWorkspace{Id: uuid(ws.ID), Name: ws.Name, IsDefault: ws.IsDefault,
			Members: int(ws.Members), Channels: int(ws.Channels), CreatedAt: ws.CreatedAt})
	}
	httpx.WriteJSON(w, http.StatusOK, struct {
		Workspaces []api.AdminWorkspace `json:"workspaces"`
	}{out})
}

// AdminListBots implements api.ServerInterface.
func (h *Handlers) AdminListBots(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !requireInstanceAdmin(w, r, p) {
		return
	}
	rows, err := h.Queries.AdminListBots(r.Context())
	if err != nil {
		h.unavailable(w, r, "list bots", err)
		return
	}
	out := make([]api.AdminBot, 0, len(rows))
	for _, b := range rows {
		out = append(out, api.AdminBot{Id: uuid(b.ID), Name: b.Name, WorkspaceId: uuid(b.WorkspaceID),
			WorkspaceName: b.WorkspaceName, Disabled: b.DisabledAt.Valid, Interactions: b.InteractionsUrl.Valid,
			CreatedAt: b.CreatedAt})
	}
	httpx.WriteJSON(w, http.StatusOK, struct {
		Bots []api.AdminBot `json:"bots"`
	}{out})
}

// AdminSetBotDisabled implements api.ServerInterface.
func (h *Handlers) AdminSetBotDisabled(w http.ResponseWriter, r *http.Request, botID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !requireInstanceAdmin(w, r, p) {
		return
	}
	var in api.AdminSetBotDisabledJSONBody
	if !decode(w, r, &in) {
		return
	}
	b, err := h.Queries.SetBotDisabled(r.Context(), store.SetBotDisabledParams{ID: pgUUID(botID), Disabled: in.Disabled})
	if isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No such bot."})
		return
	} else if err != nil {
		h.unavailable(w, r, "set bot", err)
		return
	}
	h.record(r, b.WorkspaceID, audit.BotDisabledByAdmin, "bot", botID.String(), map[string]any{"disabled": in.Disabled})
	w.WriteHeader(http.StatusNoContent)
}

// GetNotificationPolicy implements api.ServerInterface.
func (h *Handlers) GetNotificationPolicy(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !requireInstanceAdmin(w, r, p) {
		return
	}
	pol, err := h.Queries.GetNotificationPolicy(r.Context())
	if err != nil {
		h.unavailable(w, r, "notification policy", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, api.NotificationPolicy{
		PushContents: api.NotificationPolicyPushContents(pol.PushContents), EmailContents: api.NotificationPolicyEmailContents(pol.EmailContents),
	})
}

// GetSoundDefaults implements api.ServerInterface.
func (h *Handlers) GetSoundDefaults(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !requireInstanceAdmin(w, r, p) {
		return
	}
	d, err := h.Queries.GetSoundDefaults(r.Context())
	if err != nil {
		h.unavailable(w, r, "sound defaults", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, soundDefaultsAPI(d))
}

func soundDefaultsAPI(d store.GetSoundDefaultsRow) api.SoundDefaults {
	var out api.SoundDefaults
	out.Sounds.Mention, out.Sounds.Direct, out.Sounds.Message = d.SoundMention, d.SoundDirect, d.SoundMessage
	out.Volume = int(d.SoundVolume)
	return out
}

// builtinOrNone: the installation's defaults are sounds everyone has (not one
// person's own).
func builtinOrNone(s string) bool {
	return notify.ValidSound(s) && !strings.HasPrefix(s, "user:")
}

// SetSoundDefaults implements api.ServerInterface.
func (h *Handlers) SetSoundDefaults(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !requireInstanceAdmin(w, r, p) {
		return
	}
	var in api.SoundDefaults
	if !decode(w, r, &in) {
		return
	}
	if !builtinOrNone(in.Sounds.Mention) || !builtinOrNone(in.Sounds.Direct) || !builtinOrNone(in.Sounds.Message) ||
		in.Volume < 0 || in.Volume > 100 {
		badRequest(w, r, "Each sound is a built-in sound or none; the volume is 0 to 100.")
		return
	}
	if err := h.Queries.SetSoundDefaults(r.Context(), store.SetSoundDefaultsParams{
		SoundMention: in.Sounds.Mention, SoundDirect: in.Sounds.Direct, SoundMessage: in.Sounds.Message, SoundVolume: int32(in.Volume),
	}); err != nil {
		h.unavailable(w, r, "sound defaults", err)
		return
	}
	h.record(r, pgtype.UUID{}, audit.SoundDefaultsChanged, "instance", "notifications", map[string]any{
		"sounds": in.Sounds, "volume": in.Volume,
	})
	httpx.WriteJSON(w, http.StatusOK, in)
}

// ApplySoundDefaults implements api.ServerInterface.
func (h *Handlers) ApplySoundDefaults(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !requireInstanceAdmin(w, r, p) {
		return
	}
	d, err := h.Queries.GetSoundDefaults(r.Context())
	if err != nil {
		h.unavailable(w, r, "sound defaults", err)
		return
	}
	n, err := h.Queries.ApplySoundDefaults(r.Context(), store.ApplySoundDefaultsParams(d))
	if err != nil {
		h.unavailable(w, r, "apply sound defaults", err)
		return
	}
	h.record(r, pgtype.UUID{}, audit.SoundDefaultsApplied, "instance", "notifications", map[string]any{"changed": n})
	httpx.WriteJSON(w, http.StatusOK, map[string]int64{"changed": n})
}

// SetNotificationPolicy implements api.ServerInterface.
func (h *Handlers) SetNotificationPolicy(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !requireInstanceAdmin(w, r, p) {
		return
	}
	var in api.NotificationPolicy
	if !decode(w, r, &in) {
		return
	}
	if !in.PushContents.Valid() || !in.EmailContents.Valid() {
		badRequest(w, r, "push_contents is full, sender or none; email_contents is full or sender.")
		return
	}
	if err := h.Queries.SetNotificationPolicy(r.Context(), store.SetNotificationPolicyParams{
		PushContents: string(in.PushContents), EmailContents: string(in.EmailContents),
	}); err != nil {
		h.unavailable(w, r, "notification policy", err)
		return
	}
	h.record(r, pgtype.UUID{}, audit.NotificationPolicyChanged, "instance", "notifications", map[string]any{
		"push_contents": in.PushContents, "email_contents": in.EmailContents,
	})
	httpx.WriteJSON(w, http.StatusOK, in)
}

type desktopApp = struct {
	Devices  int64                                `json:"devices"`
	Platform api.AdminOverviewDesktopAppsPlatform `json:"platform"`
	Version  string                               `json:"version"`
}

func platformOf(s string) api.AdminOverviewDesktopAppsPlatform {
	p := api.AdminOverviewDesktopAppsPlatform(s)
	if !p.Valid() {
		return api.Other
	}
	return p
}

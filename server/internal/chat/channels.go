// SPDX-License-Identifier: Apache-2.0

package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/auth"
	"github.com/barisshn35/cenacle/server/internal/events"
	"github.com/barisshn35/cenacle/server/internal/httpx"
	"github.com/barisshn35/cenacle/server/internal/store"
)

// Channel kinds.
const (
	KindStandard     = "standard"
	KindAnnouncement = "announcement"
)

// Problem codes of channel operations.
const (
	CodeNotAMember       = "not_a_member"
	CodeReadOnlyChannel  = "read_only_channel"
	CodeChannelMandatory = "channel_mandatory"
	CodeNameTaken        = "channel_name_taken"
	CodeChannelArchived  = "channel_archived"
	CodeConfiguredName   = "channel_configured"
)

// Limits of channel fields (characters).
const (
	MaxChannelName = 80
	MaxTopic       = 250
)

// Visibility, channel roles and workspace roles.
const (
	Public      = "public"
	Private     = "private"
	RoleMember  = "member"
	RoleManager = "manager"

	WorkspaceOwner  = "owner"
	WorkspaceAdmin  = "admin"
	WorkspaceMember = "member"
)

// access is what a user is in a channel ("" when not a member) and in its
// workspace.
type access struct {
	ch, ws string
}

// admin: the workspace's owners and admins run its channels.
func (a access) admin() bool { return isWorkspaceAdmin(a.ws) }

func isWorkspaceAdmin(role string) bool { return role == WorkspaceOwner || role == WorkspaceAdmin }

// canPost: everyone in standard channels, only workspace owners and admins in
// announcement channels; nobody in archived ones.
func canPost(c store.Channel, a access) bool {
	return !c.ArchivedAt.Valid && (c.Kind != KindAnnouncement || a.admin())
}

// canManage: the channel's managers and the workspace's owners and admins.
func canManage(a access) bool {
	return a.admin() || a.ch == RoleManager
}

// toAPI describes a channel for a user with the given access.
func toAPI(c store.Channel, a access) api.Channel {
	member := a.ch != ""
	out := api.Channel{
		Id: uuid(c.ID), WorkspaceId: uuid(c.WorkspaceID), Name: c.Name, Topic: c.Topic, Kind: api.ChannelKind(c.Kind),
		Visibility: api.ChannelVisibility(c.Visibility),
		IsDefault:  c.IsDefault, IsMandatory: c.IsMandatory, IsMember: member,
		CanPost:   member && canPost(c, a),
		CanManage: canManage(a),
		Archived:  c.ArchivedAt.Valid,
	}
	if c.CategoryID.Valid {
		id := uuid(c.CategoryID)
		out.CategoryId = &id
	}
	return out
}

func writeChannels(w http.ResponseWriter, list []api.Channel) {
	httpx.WriteJSON(w, http.StatusOK, api.ChannelList{Channels: list})
}

// ListChannels implements api.ServerInterface.
func (h *Handlers) ListChannels(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	rows, err := h.Queries.ListMemberChannels(r.Context(), p.User.ID)
	if err != nil {
		h.unavailable(w, r, "list channels", err)
		return
	}
	out := make([]api.Channel, 0, len(rows))
	for _, row := range rows {
		out = append(out, toAPI(row.Channel, access{ch: row.Role, ws: row.WorkspaceRole}))
	}
	writeChannels(w, out)
}

// ListChannelDirectory implements api.ServerInterface.
func (h *Handlers) ListChannelDirectory(w http.ResponseWriter, r *http.Request, params api.ListChannelDirectoryParams) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	wsRole, ok := h.workspaceRole(w, r, params.WorkspaceId, p.User)
	if !ok {
		return
	}
	rows, err := h.Queries.ListAllChannels(r.Context(), store.ListAllChannelsParams{
		UserID: p.User.ID, WorkspaceID: pgUUID(params.WorkspaceId),
	})
	if err != nil {
		h.unavailable(w, r, "list channel directory", err)
		return
	}
	out := make([]api.Channel, 0, len(rows))
	for _, row := range rows {
		out = append(out, toAPI(row.Channel, access{ch: row.Role, ws: wsRole}))
	}
	writeChannels(w, out)
}

// cleanName trims a channel name and checks it.
func cleanName(name string) (string, string) {
	name = strings.TrimSpace(name)
	switch {
	case name == "":
		return "", "The channel name is empty."
	case utf8.RuneCountInString(name) > MaxChannelName:
		return "", "The channel name is longer than 80 characters."
	case !utf8.ValidString(name) || strings.ContainsFunc(name, unicode.IsControl):
		return "", "The channel name contains invalid characters."
	}
	return name, ""
}

// cleanTopic trims a topic and checks it.
func cleanTopic(topic string) (string, string) {
	topic = strings.TrimSpace(topic)
	if utf8.RuneCountInString(topic) > MaxTopic || strings.ContainsFunc(topic, unicode.IsControl) {
		return "", "The topic is longer than 250 characters or contains invalid characters."
	}
	return topic, ""
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func badRequest(w http.ResponseWriter, r *http.Request, detail string) {
	httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusBadRequest, Code: httpx.CodeBadRequest, Detail: detail})
}

func forbidden(w http.ResponseWriter, r *http.Request, code, detail string) {
	httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusForbidden, Code: code, Detail: detail})
}

// CreateChannel implements api.ServerInterface.
func (h *Handlers) CreateChannel(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.NewChannel
	if !decode(w, r, &in) {
		return
	}
	wsRole, ok := h.workspaceRole(w, r, in.WorkspaceId, p.User)
	if !ok {
		return
	}
	if !isWorkspaceAdmin(wsRole) {
		forbidden(w, r, httpx.CodeForbidden, "Only the workspace's owners and admins can create channels.")
		return
	}
	name, problem := cleanName(in.Name)
	topic := ""
	if problem == "" && in.Topic != nil {
		topic, problem = cleanTopic(*in.Topic)
	}
	kind, visibility := KindStandard, Public
	if in.Kind != nil {
		kind = string(*in.Kind)
	}
	if in.Visibility != nil {
		visibility = string(*in.Visibility)
	}
	isDefault := in.IsDefault != nil && *in.IsDefault
	switch {
	case problem != "":
	case kind != KindStandard && kind != KindAnnouncement:
		problem = "kind must be standard or announcement."
	case visibility != Public && visibility != Private:
		problem = "visibility must be public or private."
	case isDefault && visibility == Private:
		problem = "A channel for everyone cannot be private."
	}
	if problem != "" {
		badRequest(w, r, problem)
		return
	}

	c, err := h.Queries.CreateChannel(r.Context(), store.CreateChannelParams{
		WorkspaceID: pgUUID(in.WorkspaceId), Name: name, Topic: topic, Kind: kind, IsDefault: isDefault,
		Visibility: visibility, CreatedBy: p.User.ID,
	})
	if isUniqueViolation(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeNameTaken,
			Detail: "A channel with this name exists."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "create channel", err)
		return
	}
	// The creator manages the channel.
	_, err = h.Queries.AddMember(r.Context(), store.AddMemberParams{ChannelID: c.ID, UserID: p.User.ID, Role: RoleManager})
	if err == nil && isDefault {
		_, err = h.Queries.AddAllUsers(r.Context(), c.ID)
	}
	if err != nil {
		h.unavailable(w, r, "add channel members", err)
		return
	}
	out := toAPI(c, access{ch: RoleManager, ws: wsRole})
	if isDefault {
		h.publish(r.Context(), events.ChannelCreated, ChannelEvent{Channel: toAPI(c, access{ch: RoleMember})})
	} else {
		h.publish(r.Context(), events.ChannelJoined, ChannelEvent{Channel: out, UserID: uuid(p.User.ID).String()})
	}
	httpx.WriteJSON(w, http.StatusCreated, out)
}

// ChannelEvent is the data of channel.created (a default channel, for
// everyone), channel.joined and channel.left (for UserID), channel.updated
// and channel.members_changed (for the channel's members). Fields that
// depend on the user (is_member, can_post, can_manage) are not meant to be
// used from events: clients reload their channel list.
type ChannelEvent struct {
	Channel   api.Channel `json:"channel"`
	UserID    string      `json:"user_id,omitempty"`
	ChannelID string      `json:"channel_id,omitempty"`
}

// workspaceRole returns the user's role in a workspace; to non-members the
// workspace does not exist (404).
func (h *Handlers) workspaceRole(w http.ResponseWriter, r *http.Request, id openapi_types.UUID, user store.User) (string, bool) {
	role, err := h.Queries.GetWorkspaceRole(r.Context(), store.GetWorkspaceRoleParams{
		WorkspaceID: pgUUID(id), UserID: user.ID,
	})
	if err != nil {
		h.unavailable(w, r, "get workspace role", err)
		return "", false
	}
	if role == "" {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound,
			Detail: "No workspace with this id."})
		return "", false
	}
	return role, true
}

// visibleChannel loads a channel the user may see: channels of the user's
// workspaces that are public, and private ones only for their members and the
// workspace's owners and admins; anything else answers 404 as if it did not
// exist. It returns the user's access ("" channel role when not a member).
func (h *Handlers) visibleChannel(w http.ResponseWriter, r *http.Request, id openapi_types.UUID, user store.User) (store.Channel, access, bool) {
	c, ok := h.channel(w, r, id)
	if !ok {
		return c, access{}, false
	}
	ws, err := h.Queries.GetWorkspaceRole(r.Context(), store.GetWorkspaceRoleParams{WorkspaceID: c.WorkspaceID, UserID: user.ID})
	if err != nil {
		h.unavailable(w, r, "get workspace role", err)
		return c, access{}, false
	}
	ch, err := h.Queries.GetMemberRole(r.Context(), store.GetMemberRoleParams{ChannelID: c.ID, UserID: user.ID})
	if err != nil {
		h.unavailable(w, r, "get membership", err)
		return c, access{}, false
	}
	a := access{ch: ch, ws: ws}
	if ws == "" || (c.Visibility == Private && ch == "" && !a.admin()) {
		channelNotFound(w, r)
		return c, access{}, false
	}
	return c, a, true
}

// memberChannel is visibleChannel for operations that need membership.
func (h *Handlers) memberChannel(w http.ResponseWriter, r *http.Request, id openapi_types.UUID, user store.User) (store.Channel, access, bool) {
	c, role, ok := h.visibleChannel(w, r, id, user)
	if ok && role.ch == "" {
		forbidden(w, r, CodeNotAMember, "Join the channel first.")
		return c, role, false
	}
	return c, role, ok
}

// JoinChannel implements api.ServerInterface.
func (h *Handlers) JoinChannel(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	c, role, ok := h.visibleChannel(w, r, channelID, p.User)
	if !ok {
		return
	}
	if role.ch != "" {
		httpx.WriteJSON(w, http.StatusOK, toAPI(c, role))
		return
	}
	if c.Visibility == Private {
		// Private channels are joined by being added by a manager (workspace
		// admins add themselves through the member list).
		channelNotFound(w, r)
		return
	}
	if _, err := h.Queries.AddMember(r.Context(), store.AddMemberParams{ChannelID: c.ID, UserID: p.User.ID, Role: RoleMember}); err != nil {
		h.unavailable(w, r, "join channel", err)
		return
	}
	out := toAPI(c, access{ch: RoleMember, ws: role.ws})
	h.membersChanged(r.Context(), c, p.User.ID, events.ChannelJoined, out)
	httpx.WriteJSON(w, http.StatusOK, out)
}

// LeaveChannel implements api.ServerInterface.
func (h *Handlers) LeaveChannel(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	c, _, ok := h.visibleChannel(w, r, channelID, p.User)
	if !ok {
		return
	}
	if c.IsMandatory {
		forbidden(w, r, CodeChannelMandatory, "Everyone is a member of this channel.")
		return
	}
	n, err := h.Queries.RemoveMember(r.Context(), store.RemoveMemberParams{ChannelID: c.ID, UserID: p.User.ID})
	if err != nil {
		h.unavailable(w, r, "leave channel", err)
		return
	}
	if n > 0 {
		h.membersChanged(r.Context(), c, p.User.ID, events.ChannelLeft, toAPI(c, access{}))
	}
	w.WriteHeader(http.StatusNoContent)
}

// membersChanged tells the affected user (joined or left) and the channel's
// members (their member lists) about a membership change.
func (h *Handlers) membersChanged(ctx context.Context, c store.Channel, user pgtype.UUID, typ string, ch api.Channel) {
	h.publish(ctx, typ, ChannelEvent{Channel: ch, UserID: uuid(user).String()})
	h.publish(ctx, events.ChannelMembersChanged, ChannelEvent{ChannelID: uuid(c.ID).String()})
}

// UpdateChannel implements api.ServerInterface.
func (h *Handlers) UpdateChannel(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.ChannelUpdate
	if !decode(w, r, &in) {
		return
	}
	c, role, ok := h.visibleChannel(w, r, channelID, p.User)
	if !ok {
		return
	}
	if !canManage(role) {
		forbidden(w, r, httpx.CodeForbidden, "Only the channel's managers can change it.")
		return
	}
	name, visibility, topic, problem := c.Name, c.Visibility, c.Topic, ""
	if in.Name != nil {
		name, problem = cleanName(*in.Name)
	}
	if in.Visibility != nil {
		visibility = string(*in.Visibility)
	}
	if problem == "" && in.Topic != nil {
		topic, problem = cleanTopic(*in.Topic)
	}
	if name != c.Name && h.configured(c.Name) {
		// The server would create the configured name again at the next start.
		forbidden(w, r, CodeConfiguredName, "This channel is named in the installation settings.")
		return
	}
	switch {
	case problem != "":
	case visibility != Public && visibility != Private:
		problem = "visibility must be public or private."
	case visibility == Private && c.IsDefault:
		problem = "A channel for everyone cannot be private."
	}
	if problem != "" {
		badRequest(w, r, problem)
		return
	}
	c, err := h.Queries.UpdateChannel(r.Context(), store.UpdateChannelParams{
		ID: c.ID, Name: name, Visibility: visibility, Topic: topic, CategoryID: c.CategoryID,
	})
	if isUniqueViolation(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeNameTaken,
			Detail: "A channel with this name exists."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "update channel", err)
		return
	}
	h.publish(r.Context(), events.ChannelUpdated, ChannelEvent{
		Channel: toAPI(c, access{ch: RoleMember}), ChannelID: uuid(c.ID).String(),
	})
	httpx.WriteJSON(w, http.StatusOK, toAPI(c, role))
}

// ListChannelMembers implements api.ServerInterface.
func (h *Handlers) ListChannelMembers(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	c, _, ok := h.memberChannel(w, r, channelID, p.User)
	if !ok {
		return
	}
	rows, err := h.Queries.ListMembers(r.Context(), c.ID)
	if err != nil {
		h.unavailable(w, r, "list members", err)
		return
	}
	out := make([]api.Member, 0, len(rows))
	for _, m := range rows {
		out = append(out, api.Member{
			User: api.Person{Id: uuid(m.ID), DisplayName: m.DisplayName, Email: m.Email},
			Role: api.MemberRole(m.Role),
		})
	}
	httpx.WriteJSON(w, http.StatusOK, struct {
		Members []api.Member `json:"members"`
	}{out})
}

// managedChannel loads a channel the user manages, or answers.
func (h *Handlers) managedChannel(w http.ResponseWriter, r *http.Request, id openapi_types.UUID, user store.User) (store.Channel, bool) {
	c, role, ok := h.visibleChannel(w, r, id, user)
	if ok && !canManage(role) {
		forbidden(w, r, httpx.CodeForbidden, "Only the channel's managers can add or remove people.")
		return c, false
	}
	return c, ok
}

// AddChannelMember implements api.ServerInterface.
func (h *Handlers) AddChannelMember(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in struct {
		UserID openapi_types.UUID `json:"user_id"`
	}
	if !decode(w, r, &in) {
		return
	}
	c, ok := h.managedChannel(w, r, channelID, p.User)
	if !ok {
		return
	}
	u, err := h.Queries.GetUser(r.Context(), pgUUID(in.UserID))
	if isNoRows(err) {
		badRequest(w, r, "No user with this id.")
		return
	}
	if err != nil {
		h.unavailable(w, r, "get user", err)
		return
	}
	// Only members of the workspace can join its channels.
	targetWs, err := h.Queries.GetWorkspaceRole(r.Context(), store.GetWorkspaceRoleParams{WorkspaceID: c.WorkspaceID, UserID: u.ID})
	if err != nil {
		h.unavailable(w, r, "get workspace role", err)
		return
	}
	if targetWs == "" {
		badRequest(w, r, "This person is not a member of the workspace.")
		return
	}
	n, err := h.Queries.AddMember(r.Context(), store.AddMemberParams{ChannelID: c.ID, UserID: u.ID, Role: RoleMember})
	if err != nil {
		h.unavailable(w, r, "add member", err)
		return
	}
	role, err := h.Queries.GetMemberRole(r.Context(), store.GetMemberRoleParams{ChannelID: c.ID, UserID: u.ID})
	if err != nil {
		h.unavailable(w, r, "get membership", err)
		return
	}
	if n > 0 {
		h.membersChanged(r.Context(), c, u.ID, events.ChannelJoined, toAPI(c, access{ch: RoleMember, ws: targetWs}))
	}
	httpx.WriteJSON(w, http.StatusOK, api.Member{
		User: api.Person{Id: uuid(u.ID), DisplayName: u.DisplayName, Email: u.Email}, Role: api.MemberRole(role),
	})
}

// RemoveChannelMember implements api.ServerInterface.
func (h *Handlers) RemoveChannelMember(w http.ResponseWriter, r *http.Request, channelID, userID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	c, ok := h.managedChannel(w, r, channelID, p.User)
	if !ok {
		return
	}
	switch {
	case c.IsMandatory:
		forbidden(w, r, CodeChannelMandatory, "Everyone is a member of this channel.")
		return
	case pgUUID(userID) == p.User.ID:
		badRequest(w, r, "To remove yourself, leave the channel.")
		return
	}
	n, err := h.Queries.RemoveMember(r.Context(), store.RemoveMemberParams{ChannelID: c.ID, UserID: pgUUID(userID)})
	if err != nil {
		h.unavailable(w, r, "remove member", err)
		return
	}
	if n > 0 {
		h.membersChanged(r.Context(), c, pgUUID(userID), events.ChannelLeft, toAPI(c, access{}))
	}
	w.WriteHeader(http.StatusNoContent)
}

// SearchUsers implements api.ServerInterface.
func (h *Handlers) SearchUsers(w http.ResponseWriter, r *http.Request, params api.SearchUsersParams) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	if _, ok := h.workspaceRole(w, r, params.WorkspaceId, p.User); !ok {
		return
	}
	q := strings.TrimSpace(params.Q)
	limit := 20
	if params.Limit != nil {
		limit = *params.Limit
	}
	if q == "" || utf8.RuneCountInString(q) > 100 || limit < 1 || limit > 50 {
		badRequest(w, r, "q must have 1 to 100 characters and limit be between 1 and 50.")
		return
	}
	// The search text is literal: escape LIKE's wildcards.
	escaped := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(q)
	rows, err := h.Queries.SearchUsers(r.Context(), store.SearchUsersParams{
		WorkspaceID: pgUUID(params.WorkspaceId), Pattern: "%" + escaped + "%", RowLimit: int32(limit),
	})
	if err != nil {
		h.unavailable(w, r, "search users", err)
		return
	}
	out := make([]api.Person, 0, len(rows))
	for _, u := range rows {
		out = append(out, api.Person{Id: uuid(u.ID), DisplayName: u.DisplayName, Email: u.Email})
	}
	httpx.WriteJSON(w, http.StatusOK, struct {
		Users []api.Person `json:"users"`
	}{out})
}

func (h *Handlers) publish(ctx context.Context, typ string, data any) {
	if _, err := h.Events.Append(ctx, typ, data); err != nil {
		h.Log.ErrorContext(ctx, "append event", "type", typ, "error", err,
			"request_id", httpx.RequestIDFrom(ctx))
	}
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusBadRequest, Code: httpx.CodeBadRequest,
			Detail: "The body is not valid JSON for this operation."})
		return false
	}
	return true
}

// Defaults are the channels configured at installation; they belong to the
// default workspace.
type Defaults struct {
	Announcement string
	Channels     []string
	AdminEmail   string
}

// EnsureDefaults makes sure the default workspace exists with every user in
// it, creates its configured channels (or brings existing ones to the
// configured kind) with every member in them, and takes the administrator
// flag from users whose address is no longer configured. It is safe to run on
// every start of every instance.
func EnsureDefaults(ctx context.Context, q store.Querier, d Defaults) error {
	ws, err := q.GetDefaultWorkspace(ctx)
	if isNoRows(err) {
		ws, err = q.CreateWorkspace(ctx, store.CreateWorkspaceParams{Name: "Cenacle", IsDefault: true})
	}
	if err != nil {
		return fmt.Errorf("default workspace: %w", err)
	}
	if _, err := q.AddAllUsersToWorkspace(ctx, ws.ID); err != nil {
		return fmt.Errorf("members of the default workspace: %w", err)
	}
	type spec struct {
		name, topic, kind string
		mandatory         bool
	}
	var specs []spec
	if d.Announcement != "" {
		specs = append(specs, spec{d.Announcement, "Announcements for everyone.", KindAnnouncement, true})
	}
	for _, name := range d.Channels {
		specs = append(specs, spec{name, "", KindStandard, false})
	}
	for _, s := range specs {
		c, err := q.EnsureChannel(ctx, store.EnsureChannelParams{
			WorkspaceID: ws.ID, Name: s.name, Topic: s.topic, Kind: s.kind, IsDefault: true, IsMandatory: s.mandatory,
		})
		if err != nil {
			return fmt.Errorf("ensure channel %q: %w", s.name, err)
		}
		if _, err := q.AddAllUsers(ctx, c.ID); err != nil {
			return fmt.Errorf("members of %q: %w", s.name, err)
		}
	}
	if err := q.RevokeAdminUnlessEmail(ctx, d.AdminEmail); err != nil {
		return fmt.Errorf("administrator: %w", err)
	}
	return nil
}

// RunEnsureDefaults retries EnsureDefaults until it succeeds or ctx ends: the
// server starts even while the database is down.
func RunEnsureDefaults(ctx context.Context, q store.Querier, d Defaults, log *slog.Logger) {
	backoff := time.Second
	for {
		err := EnsureDefaults(ctx, q, d)
		if err == nil {
			log.Info("default channels ready", "announcement", d.Announcement, "default", d.Channels)
			if d.AdminEmail == "" {
				log.Warn("no administrator configured (CENACLE_ADMIN_EMAIL): nobody owns the default workspace yet")
			}
			return
		}
		log.Warn("default channels not ready", "error", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}

func isNoRows(err error) bool { return errors.Is(err, pgx.ErrNoRows) }

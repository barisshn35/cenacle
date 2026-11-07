// SPDX-License-Identifier: AGPL-3.0-only

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

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/audit"
	"github.com/Cenacle-TR/cenacle/server/internal/auth"
	"github.com/Cenacle-TR/cenacle/server/internal/events"
	"github.com/Cenacle-TR/cenacle/server/internal/httpx"
	"github.com/Cenacle-TR/cenacle/server/internal/policy"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

// Channel kinds.
const (
	KindStandard     = "standard"
	KindAnnouncement = "announcement"
	KindForum        = "forum"
	// Direct (two people) and group conversations: private, without
	// managers, keyed by their people (see conversationKey).
	KindDirect = "direct"
	KindGroup  = "group"
)

// isConversation: direct and group conversations, which only their people
// see and nobody manages.
func isConversation(c store.Channel) bool { return c.Kind == KindDirect || c.Kind == KindGroup }

// Problem codes of channel operations.
const (
	CodeNotAMember       = "not_a_member"
	CodeReadOnlyChannel  = "read_only_channel"
	CodeChannelMandatory = "channel_mandatory"
	CodeNameTaken        = "channel_name_taken"
	CodeGroupManaged     = "group_managed"
	CodeChannelArchived  = "channel_archived"
	CodeConfiguredName   = "channel_configured"
	CodeNoBroadcast      = "broadcast_not_allowed"
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
	// WorkspaceGuest sees only the channels they are added to and the people in them.
	WorkspaceGuest = "guest"
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
// announcement channels; nobody in archived ones. A channel's moderation may
// leave posting to its managers.
func canPost(c store.Channel, a access) bool {
	return !c.ArchivedAt.Valid && (c.Kind != KindAnnouncement || a.admin()) &&
		(!managersOnly(moderationOf(c).Post) || canManage(c, a))
}

// canManage: the channel's managers and the workspace's owners and admins;
// nobody in conversations.
func canManage(c store.Channel, a access) bool {
	return !isConversation(c) && (a.admin() || a.ch == RoleManager)
}

// toAPI describes a channel for a user with the given access.
func toAPI(c store.Channel, a access) api.Channel {
	member := a.ch != ""
	out := api.Channel{
		Id: uuid(c.ID), WorkspaceId: uuid(c.WorkspaceID), Name: c.Name, Topic: c.Topic, Kind: api.ChannelKind(c.Kind),
		Visibility: api.ChannelVisibility(c.Visibility),
		IsDefault:  c.IsDefault, IsMandatory: c.IsMandatory, IsMember: member,
		CanPost:         member && canPost(c, a),
		CanManage:       canManage(c, a),
		CanReply:        ptr(member && canReply(c, a)),
		CanReact:        ptr(member && canReact(c, a)),
		CanBroadcast:    ptr(member && canBroadcastHere(c, a)),
		Moderation:      ptr(moderationAPI(c)),
		Archived:        c.ArchivedAt.Valid,
		GroupManaged:    c.GroupManaged,
		Participants:    []api.Person{},
		SlowModeSeconds: ptr(int(c.SlowModeSeconds)),
		ForumTags:       ptr(append([]string{}, c.ForumTags...)),
		Encrypted:       ptr(c.Encrypted),
		AccessRules:     ptr(accessRules(c)),
	}
	if c.Encrypted {
		out.KeyCheck = &c.KeyCheck
	}
	if c.Mls {
		out.Mls = ptr(true)
	}
	if c.ClassificationID.Valid {
		id := uuid(c.ClassificationID)
		out.ClassificationId = &id
	}
	if c.RetentionDays.Valid {
		out.RetentionDays = ptr(int(c.RetentionDays.Int32))
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
	people, err := h.participants(r.Context(), p.User.ID)
	if err != nil {
		h.unavailable(w, r, "list participants", err)
		return
	}
	out := make([]api.Channel, 0, len(rows))
	for _, row := range rows {
		c := toAPI(row.Channel, access{ch: row.Role, ws: row.WorkspaceRole})
		c.UnreadCount = int(row.UnreadCount)
		c.MentionCount = int(row.MentionCount)
		if row.LastReadID.Valid {
			id := uuid(row.LastReadID)
			c.LastReadId = &id
		}
		if list, ok := people[c.Id]; ok {
			c.Participants = list
		}
		out = append(out, c)
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
		if wsRole == WorkspaceGuest && row.Role == "" {
			continue // guests see their own channels only
		}
		c := toAPI(row.Channel, access{ch: row.Role, ws: wsRole})
		n := int(row.MemberCount)
		c.MemberCount = &n
		out = append(out, c)
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
	case hasConversationPrefix(name):
		return "", "Channel names cannot start with \"direct:\" or \"group:\"."
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
	if _, _, ok := h.requirePermission(w, r, in.WorkspaceId, p.User, PermCreateChannels,
		"Your role in this workspace does not create channels."); !ok {
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
	// Guests never share a channel for everyone, even when the workspace lets
	// them create channels: it would show them every member.
	if isDefault && wsRole == WorkspaceGuest {
		forbidden(w, r, httpx.CodeForbidden, "Guests do not create channels for everyone.")
		return
	}
	encrypted, keyCheck := in.Encrypted != nil && *in.Encrypted, deref1(in.KeyCheck)
	switch {
	case problem != "":
	case kind != KindStandard && kind != KindAnnouncement && kind != KindForum:
		problem = "kind must be standard, announcement or forum."
	case visibility != Public && visibility != Private:
		problem = "visibility must be public or private."
	case isDefault && visibility == Private:
		problem = "A channel for everyone cannot be private."
	case encrypted && kind == KindForum:
		problem = "Forums cannot be encrypted: their titles are not."
	case encrypted && !isKeyCheck(keyCheck):
		problem = "An encrypted channel needs its key check."
	case !encrypted && keyCheck != "":
		problem = "Only an encrypted channel has a key check."
	}
	if problem != "" {
		badRequest(w, r, problem)
		return
	}

	c, err := h.Queries.CreateChannel(r.Context(), store.CreateChannelParams{
		WorkspaceID: pgUUID(in.WorkspaceId), Name: name, Topic: topic, Kind: kind, IsDefault: isDefault,
		Visibility: visibility, CreatedBy: p.User.ID, Encrypted: encrypted, KeyCheck: keyCheck,
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
	h.record(r, c.WorkspaceID, audit.ChannelCreated, "channel", uuid(c.ID).String(),
		map[string]any{"channel": c.Name, "visibility": c.Visibility, "kind": c.Kind, "everyone": isDefault, "encrypted": encrypted})
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
	// Guests see their own channels only, public ones included.
	hidden := c.Visibility == Private || ws == WorkspaceGuest
	if ws == "" || (hidden && ch == "" && (!a.admin() || isConversation(c))) {
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
	if c.GroupManaged {
		forbidden(w, r, CodeGroupManaged, "Membership of this channel follows directory groups.")
		return
	}
	if !h.mayJoin(w, r, c, p.User.ID) {
		return
	}
	if _, err := h.Queries.AddMember(r.Context(), store.AddMemberParams{ChannelID: c.ID, UserID: p.User.ID, Role: RoleMember}); err != nil {
		h.unavailable(w, r, "join channel", err)
		return
	}
	out := toAPI(c, access{ch: RoleMember, ws: role.ws})
	h.membersChanged(r.Context(), c, p.User.ID, events.ChannelJoined, out)
	h.channelLine(r.Context(), c, LineJoined, p.User.ID, p.User.ID)
	h.memberJoined(r.Context(), c, p.User)
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
	if c.GroupManaged {
		forbidden(w, r, CodeGroupManaged, "Membership of this channel follows directory groups.")
		return
	}
	n, err := h.Queries.RemoveMember(r.Context(), store.RemoveMemberParams{ChannelID: c.ID, UserID: p.User.ID})
	if err != nil {
		h.unavailable(w, r, "leave channel", err)
		return
	}
	if n > 0 {
		h.membersChanged(r.Context(), c, p.User.ID, events.ChannelLeft, toAPI(c, access{}))
		h.channelLine(r.Context(), c, LineLeft, p.User.ID, p.User.ID)
	}
	w.WriteHeader(http.StatusNoContent)
}

// membersChanged tells the affected user (joined or left) and the channel's
// members (their member lists) about a membership change.
func (h *Handlers) membersChanged(ctx context.Context, c store.Channel, user pgtype.UUID, typ string, ch api.Channel) {
	h.publish(ctx, typ, ChannelEvent{Channel: ch, UserID: uuid(user).String()})
	h.publish(ctx, events.ChannelMembersChanged, ChannelEvent{ChannelID: uuid(c.ID).String()})
	if c.Mls && typ == events.ChannelLeft {
		// The devices of someone who left are to be removed from the group.
		h.publish(ctx, events.E2EChanged, ChannelEvent{ChannelID: uuid(c.ID).String()})
	}
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
	if !canManage(c, role) {
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
	slow, tags := c.SlowModeSeconds, c.ForumTags
	if problem == "" && in.SlowModeSeconds != nil {
		if *in.SlowModeSeconds < 0 || *in.SlowModeSeconds > MaxSlowMode {
			problem = "slow_mode_seconds must be between 0 and 21600."
		} else {
			slow = int32(*in.SlowModeSeconds) //nolint:gosec // checked just above
		}
	}
	if problem == "" && in.ForumTags != nil {
		tags, problem = cleanTags(*in.ForumTags, MaxForumTags)
	}
	mod := c.Moderation
	if problem == "" && in.Moderation != nil {
		mod, problem = cleanModeration(*in.Moderation)
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
	before := c
	c, err := h.Queries.UpdateChannel(r.Context(), store.UpdateChannelParams{
		ID: c.ID, Name: name, Visibility: visibility, Topic: topic, CategoryID: c.CategoryID,
		SlowModeSeconds: slow, ForumTags: tags, Moderation: mod,
	})
	if err == nil && string(before.Moderation) != string(c.Moderation) {
		h.record(r, c.WorkspaceID, audit.ChannelModerationChanged, "channel", uuid(c.ID).String(), map[string]any{
			"channel": c.Name, "moderation": moderationAPI(c),
		})
	}
	if err == nil && before.SlowModeSeconds != c.SlowModeSeconds {
		h.record(r, c.WorkspaceID, audit.SlowModeChanged, "channel", uuid(c.ID).String(), map[string]any{
			"channel": c.Name, "seconds": c.SlowModeSeconds,
		})
	}
	if err == nil && (before.Name != c.Name || before.Visibility != c.Visibility) {
		h.record(r, c.WorkspaceID, audit.ChannelUpdated, "channel", uuid(c.ID).String(), map[string]any{
			"channel": c.Name, "previous_name": before.Name, "visibility": c.Visibility,
			"previous_visibility": before.Visibility,
		})
	}
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
			User: personAPI(m.ID, m.DisplayName, m.Email, m.IsBot),
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
	if ok && !canManage(c, role) {
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
	if c.GroupManaged {
		forbidden(w, r, CodeGroupManaged, "Membership of this channel follows directory groups.")
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
	if !h.mayJoin(w, r, c, u.ID) {
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
		h.channelLine(r.Context(), c, LineAdded, u.ID, p.User.ID)
		h.memberJoined(r.Context(), c, u)
		h.record(r, c.WorkspaceID, audit.ChannelMemberAdded, "channel", uuid(c.ID).String(),
			map[string]any{"channel": c.Name, "user_id": uuid(u.ID).String(), "user": u.DisplayName})
	}
	httpx.WriteJSON(w, http.StatusOK, api.Member{
		User: personAPI(u.ID, u.DisplayName, u.Email, u.IsBot), Role: api.MemberRole(role),
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
	if c.GroupManaged {
		forbidden(w, r, CodeGroupManaged, "Membership of this channel follows directory groups.")
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
		h.channelLine(r.Context(), c, LineRemoved, pgUUID(userID), p.User.ID)
		h.record(r, c.WorkspaceID, audit.ChannelMemberRemoved, "channel", uuid(c.ID).String(),
			map[string]any{"channel": c.Name, "user_id": userID.String()})
	}
	w.WriteHeader(http.StatusNoContent)
}

// SearchUsers implements api.ServerInterface.
func (h *Handlers) SearchUsers(w http.ResponseWriter, r *http.Request, params api.SearchUsersParams) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	wsRole, ok := h.workspaceRole(w, r, params.WorkspaceId, p.User)
	if !ok {
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
	// A guest's visibility applies in the query, before the limit: people
	// the guest may not see must not take places in the result.
	visible, ok := h.visiblePeople(w, r, params.WorkspaceId, p.User, wsRole)
	if !ok {
		return
	}
	in := store.SearchUsersParams{
		WorkspaceID: pgUUID(params.WorkspaceId), Pattern: "%" + escaped + "%", RowLimit: int32(limit),
		Restrict: visible != nil, VisibleIds: []pgtype.UUID{},
	}
	for id := range visible {
		in.VisibleIds = append(in.VisibleIds, id)
	}
	rows, err := h.Queries.SearchUsers(r.Context(), in)
	if err != nil {
		h.unavailable(w, r, "search users", err)
		return
	}
	out := make([]api.Person, 0, len(rows))
	for _, u := range rows {
		if visible != nil && !visible[u.ID] {
			continue
		}
		out = append(out, personAPI(u.ID, u.DisplayName, u.Email, u.IsBot))
	}
	httpx.WriteJSON(w, http.StatusOK, struct {
		Users []api.Person `json:"users"`
	}{out})
}

// visiblePeople is who a guest may see in a workspace (people sharing a
// channel with them); nil for everyone else (no limit).
func (h *Handlers) visiblePeople(w http.ResponseWriter, r *http.Request, ws openapi_types.UUID, user store.User, wsRole string) (map[pgtype.UUID]bool, bool) {
	out, err := policy.VisiblePeople(r.Context(), h.Queries, pgUUID(ws), user.ID, wsRole)
	if err != nil {
		h.unavailable(w, r, "people sharing channels", err)
		return nil, false
	}
	return out, true
}

// publish records an event in the outbox (outside a transaction: the change
// it describes is already stored).
func (h *Handlers) publish(ctx context.Context, typ string, data any) {
	if err := emit(ctx, h.Queries, typ, data); err != nil {
		h.Log.ErrorContext(ctx, "append event", "type", typ, "error", err,
			"request_id", httpx.RequestIDFrom(ctx))
	}
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	return decodeLimit(w, r, v, 64<<10)
}

// decodeLimit is decode for bodies up to limit bytes.
func decodeLimit(w http.ResponseWriter, r *http.Request, v any, limit int64) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusBadRequest, Code: httpx.CodeBadRequest,
			Detail: "The body is not valid JSON for this operation."})
		return false
	}
	if httpx.HasNUL(v) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusBadRequest, Code: httpx.CodeBadRequest,
			Detail: "Text may not contain the NUL character."})
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
		if isNoRows(err) {
			// A private, ruled or encrypted channel has this name: its members
			// stay the ones its managers chose.
			slog.WarnContext(ctx, "configured channel name is taken by a channel that is not open to everyone; not applied",
				"channel", s.name)
			continue
		}
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

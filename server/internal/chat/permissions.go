// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"encoding/json"
	"net/http"
	"slices"

	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/audit"
	"github.com/barisshn35/cenacle/server/internal/auth"
	"github.com/barisshn35/cenacle/server/internal/events"
	"github.com/barisshn35/cenacle/server/internal/httpx"
	"github.com/barisshn35/cenacle/server/internal/store"
)

// Workspace permissions: what the roles of a workspace may do. Owners may do
// everything. Bots stay with the owners and admins (they hold secrets), and
// group creation keeps its own setting.
const (
	PermCreateChannels = "create_channels"
	PermInvite         = "invite_people"
	PermCategories     = "manage_categories"
	PermEmoji          = "custom_emoji"
	PermBroadcast      = "broadcast_mentions"
	PermGroupMentions  = "group_mentions"
	PermGuestLinks     = "guest_links"
)

// Roles a permission scheme names (owners always may).
var schemeRoles = []string{WorkspaceAdmin, WorkspaceMember, WorkspaceGuest}

// DefaultPermissions are what 0.33 allowed before schemes existed.
var DefaultPermissions = map[string][]string{
	PermCreateChannels: {WorkspaceAdmin},
	PermInvite:         {WorkspaceAdmin},
	PermCategories:     {WorkspaceAdmin},
	PermEmoji:          {WorkspaceAdmin, WorkspaceMember},
	PermBroadcast:      {WorkspaceAdmin, WorkspaceMember, WorkspaceGuest},
	PermGroupMentions:  {WorkspaceAdmin, WorkspaceMember, WorkspaceGuest},
	PermGuestLinks:     {WorkspaceAdmin},
}

// Permissions are a workspace's scheme: each permission's roles.
type Permissions map[string][]string

// permissionsOf reads a workspace's scheme over the defaults.
func permissionsOf(raw []byte) Permissions {
	out := Permissions{}
	for k, v := range DefaultPermissions {
		out[k] = v
	}
	var set map[string][]string
	if json.Unmarshal(raw, &set) == nil {
		for k, v := range set {
			if _, known := DefaultPermissions[k]; known {
				out[k] = v
			}
		}
	}
	return out
}

// Allows tells whether a workspace role may do something.
func (p Permissions) Allows(perm, role string) bool {
	if role == WorkspaceOwner {
		return true
	}
	return slices.Contains(p[perm], role)
}

// can lists what a role may do, in the defaults' order.
func (p Permissions) can(role string) []string {
	out := []string{}
	for _, perm := range permissionOrder {
		if p.Allows(perm, role) {
			out = append(out, perm)
		}
	}
	return out
}

var permissionOrder = []string{
	PermCreateChannels, PermInvite, PermCategories, PermEmoji, PermBroadcast, PermGroupMentions, PermGuestLinks,
}

// requirePermission answers 403 unless the user's role in the workspace may.
func (h *Handlers) requirePermission(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID, user store.User, perm, detail string) (store.Workspace, string, bool) {
	role, ok := h.workspaceRole(w, r, workspaceID, user)
	if !ok {
		return store.Workspace{}, "", false
	}
	ws, err := h.Queries.GetWorkspace(r.Context(), pgUUID(workspaceID))
	if err != nil {
		h.unavailable(w, r, "get workspace", err)
		return ws, "", false
	}
	if !permissionsOf(ws.Permissions).Allows(perm, role) {
		forbidden(w, r, httpx.CodeForbidden, detail)
		return ws, role, false
	}
	return ws, role, true
}

// schemeOf loads the permission scheme of a channel's workspace.
func (h *Handlers) schemeOf(w http.ResponseWriter, r *http.Request, c store.Channel) (Permissions, bool) {
	ws, err := h.Queries.GetWorkspace(r.Context(), c.WorkspaceID)
	if err != nil {
		h.unavailable(w, r, "get workspace", err)
		return nil, false
	}
	return permissionsOf(ws.Permissions), true
}

// SetWorkspacePermissions implements api.ServerInterface.
func (h *Handlers) SetWorkspacePermissions(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.SetWorkspacePermissionsJSONBody
	if !decode(w, r, &in) {
		return
	}
	ws, role, ok := h.administeredWorkspace(w, r, workspaceID, p.User)
	if !ok {
		return
	}
	set := Permissions{}
	for perm, roles := range in.Permissions {
		if _, known := DefaultPermissions[perm]; !known {
			badRequest(w, r, "Unknown permission "+perm+".")
			return
		}
		clean := []string{}
		for _, r := range schemeRoles {
			if slices.Contains(roles, r) {
				clean = append(clean, r)
			}
		}
		for _, r2 := range roles {
			if !slices.Contains(schemeRoles, r2) {
				badRequest(w, r, "Roles are admin, member and guest (owners may do everything).")
				return
			}
		}
		set[perm] = clean
	}
	raw, _ := json.Marshal(set)
	ws, err := h.Queries.SetWorkspacePermissions(r.Context(), store.SetWorkspacePermissionsParams{ID: ws.ID, Permissions: raw})
	if err != nil {
		h.unavailable(w, r, "set permissions", err)
		return
	}
	h.record(r, ws.ID, audit.PermissionsChanged, "workspace", uuid(ws.ID).String(), map[string]any{"permissions": set})
	h.publish(r.Context(), events.WorkspaceUpdated, WorkspaceEvent{WorkspaceID: uuid(ws.ID).String()})
	httpx.WriteJSON(w, http.StatusOK, workspaceAPI(ws, role))
}

// Channel moderation: who may post, reply, react and mention everyone.
const (
	ModEveryone = "everyone"
	ModManagers = "managers"
)

type moderation struct {
	Post      string `json:"post,omitempty"`
	Reply     string `json:"reply,omitempty"`
	React     string `json:"react,omitempty"`
	Broadcast string `json:"broadcast,omitempty"`
}

func moderationOf(c store.Channel) moderation {
	var m moderation
	_ = json.Unmarshal(c.Moderation, &m)
	return m
}

// managersOnly is a moderation rule that leaves the others out.
func managersOnly(rule string) bool { return rule == ModManagers }

// canReply: posting, and replies not limited to the channel's managers.
func canReply(c store.Channel, a access) bool {
	return canPost(c, a) && (!managersOnly(moderationOf(c).Reply) || canManage(c, a))
}

// canReact: an open channel whose reactions are not limited to its managers.
func canReact(c store.Channel, a access) bool {
	return !c.ArchivedAt.Valid && (!managersOnly(moderationOf(c).React) || canManage(c, a))
}

// canBroadcastHere: the channel lets the person mention everyone (the
// workspace's scheme is checked as well).
func canBroadcastHere(c store.Channel, a access) bool {
	return !managersOnly(moderationOf(c).Broadcast) || canManage(c, a)
}

func moderationAPI(c store.Channel) api.ChannelModeration {
	m := moderationOf(c)
	rule := func(v string) api.ModerationRule {
		if managersOnly(v) {
			return api.ModerationRuleManagers
		}
		return api.ModerationRuleEveryone
	}
	return api.ChannelModeration{Post: rule(m.Post), Reply: rule(m.Reply), React: rule(m.React), Broadcast: rule(m.Broadcast)}
}

// cleanModeration checks a channel's new moderation.
func cleanModeration(in api.ChannelModeration) ([]byte, string) {
	out := moderation{}
	for _, f := range []struct {
		in  api.ModerationRule
		out *string
	}{{in.Post, &out.Post}, {in.Reply, &out.Reply}, {in.React, &out.React}, {in.Broadcast, &out.Broadcast}} {
		switch f.in {
		case api.ModerationRuleEveryone:
		case api.ModerationRuleManagers:
			*f.out = ModManagers
		default:
			return nil, "Each rule is everyone or managers."
		}
	}
	raw, _ := json.Marshal(out)
	return raw, ""
}

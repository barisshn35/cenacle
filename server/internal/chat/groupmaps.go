// SPDX-License-Identifier: Apache-2.0

package chat

import (
	"context"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/audit"
	"github.com/barisshn35/cenacle/server/internal/auth"
	"github.com/barisshn35/cenacle/server/internal/groups"
	"github.com/barisshn35/cenacle/server/internal/httpx"
	"github.com/barisshn35/cenacle/server/internal/store"
)

func cleanGroupName(name string) (string, bool) {
	name = strings.TrimSpace(name)
	return name, name != "" && utf8.RuneCountInString(name) <= 200 && !strings.ContainsFunc(name, unicode.IsControl)
}

// workspaceAdmin answers 403 unless the user owns or administers the workspace.
func (h *Handlers) workspaceAdmin(w http.ResponseWriter, r *http.Request, id openapi_types.UUID, user store.User) bool {
	role, ok := h.workspaceRole(w, r, id, user)
	if !ok {
		return false
	}
	if !isWorkspaceAdmin(role) {
		forbidden(w, r, httpx.CodeForbidden, "Only the workspace's owners and admins manage its groups.")
		return false
	}
	return true
}

// reapply brings the memberships of the people of some groups (and of other
// people given) in line with the mappings, after the mappings changed.
func (h *Handlers) reapply(ctx context.Context, names []string, others []pgtype.UUID) error {
	seen := map[pgtype.UUID]bool{}
	var people []store.User
	for _, n := range names {
		users, err := h.Queries.UsersInGroup(ctx, n)
		if err != nil {
			return err
		}
		for _, u := range users {
			if !seen[u.ID] {
				seen[u.ID] = true
				people = append(people, u)
			}
		}
	}
	for _, id := range others {
		if seen[id] {
			continue
		}
		u, err := h.Queries.GetUser(ctx, id)
		if err != nil {
			return err
		}
		seen[id] = true
		people = append(people, u)
	}
	for _, u := range people {
		names, err := h.Queries.ListUserGroups(ctx, u.ID)
		if err != nil {
			return err
		}
		err = h.inTx(ctx, func(q *store.Queries) error {
			return groups.Apply(ctx, q, u, groups.Profile{
				Username: u.Username.String, Role: u.DirectoryRole.String, Groups: names,
			}, h.AdminEmail)
		})
		if err != nil {
			return err
		}
	}
	return nil
}

// ListWorkspaceGroups implements api.ServerInterface.
func (h *Handlers) ListWorkspaceGroups(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !h.workspaceAdmin(w, r, workspaceID, p.User) {
		return
	}
	rows, err := h.Queries.ListWorkspaceGroupMappings(r.Context(), pgUUID(workspaceID))
	if err != nil {
		h.unavailable(w, r, "list group mappings", err)
		return
	}
	known, err := h.Queries.ListKnownGroups(r.Context())
	if err != nil {
		h.unavailable(w, r, "list groups", err)
		return
	}
	out := make([]api.GroupMapping, 0, len(rows))
	for _, m := range rows {
		out = append(out, api.GroupMapping{Group: m.GroupName, Role: api.GroupMappingRole(m.Role)})
	}
	httpx.WriteJSON(w, http.StatusOK, struct {
		Mappings []api.GroupMapping `json:"mappings"`
		Groups   []string           `json:"groups"`
	}{out, append([]string{}, known...)})
}

// SetWorkspaceGroup implements api.ServerInterface.
func (h *Handlers) SetWorkspaceGroup(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.GroupMapping
	if !decode(w, r, &in) {
		return
	}
	if !h.workspaceAdmin(w, r, workspaceID, p.User) {
		return
	}
	name, valid := cleanGroupName(in.Group)
	role := string(in.Role)
	if !valid || (role != WorkspaceAdmin && role != WorkspaceMember && role != WorkspaceGuest) {
		badRequest(w, r, "Name a group (up to 200 characters) and a role: admin, member or guest.")
		return
	}
	m, err := h.Queries.UpsertWorkspaceGroupMapping(r.Context(), store.UpsertWorkspaceGroupMappingParams{
		WorkspaceID: pgUUID(workspaceID), GroupName: name, Role: role,
	})
	if err != nil {
		h.unavailable(w, r, "save group mapping", err)
		return
	}
	if err := h.reapply(r.Context(), []string{name}, nil); err != nil {
		h.unavailable(w, r, "apply group mapping", err)
		return
	}
	h.record(r, pgUUID(workspaceID), audit.GroupMappingSet, "group", name, map[string]any{"role": role})
	httpx.WriteJSON(w, http.StatusOK, api.GroupMapping{Group: m.GroupName, Role: api.GroupMappingRole(m.Role)})
}

// DeleteWorkspaceGroup implements api.ServerInterface.
func (h *Handlers) DeleteWorkspaceGroup(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID, group string) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !h.workspaceAdmin(w, r, workspaceID, p.User) {
		return
	}
	n, err := h.Queries.DeleteWorkspaceGroupMapping(r.Context(), store.DeleteWorkspaceGroupMappingParams{
		WorkspaceID: pgUUID(workspaceID), GroupName: group,
	})
	if err != nil {
		h.unavailable(w, r, "delete group mapping", err)
		return
	}
	if n == 0 {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No mapping for this group."})
		return
	}
	if err := h.reapply(r.Context(), []string{group}, nil); err != nil {
		h.unavailable(w, r, "apply group mapping", err)
		return
	}
	h.record(r, pgUUID(workspaceID), audit.GroupMappingDeleted, "group", group, nil)
	w.WriteHeader(http.StatusNoContent)
}

// GetChannelGroups implements api.ServerInterface.
func (h *Handlers) GetChannelGroups(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	c, ok := h.managedChannel(w, r, channelID, p.User)
	if !ok {
		return
	}
	names, err := h.Queries.ListChannelGroupMappings(r.Context(), c.ID)
	if err != nil {
		h.unavailable(w, r, "list channel groups", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, api.ChannelGroups{Groups: append([]string{}, names...), Managed: c.GroupManaged})
}

// SetChannelGroups implements api.ServerInterface.
func (h *Handlers) SetChannelGroups(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.ChannelGroups
	if !decode(w, r, &in) {
		return
	}
	c, ok := h.managedChannel(w, r, channelID, p.User)
	if !ok {
		return
	}
	if isConversation(c) || c.IsDefault {
		badRequest(w, r, "Conversations and channels for everyone have no groups.")
		return
	}
	var wanted []string
	for _, g := range in.Groups {
		name, valid := cleanGroupName(g)
		if !valid || len(wanted) == 50 {
			badRequest(w, r, "Up to 50 groups, each up to 200 characters.")
			return
		}
		wanted = append(wanted, name)
	}
	if in.Managed && len(wanted) == 0 {
		badRequest(w, r, "A channel managed by groups needs at least one group.")
		return
	}
	before, err := h.Queries.ListChannelGroupMappings(r.Context(), c.ID)
	if err != nil {
		h.unavailable(w, r, "list channel groups", err)
		return
	}
	members, err := h.Queries.ListChannelMemberIDs(r.Context(), c.ID)
	if err != nil {
		h.unavailable(w, r, "list members", err)
		return
	}
	err = h.inTx(r.Context(), func(q *store.Queries) error {
		for _, g := range before {
			if _, err := q.DeleteChannelGroupMapping(r.Context(), store.DeleteChannelGroupMappingParams{ChannelID: c.ID, GroupName: g}); err != nil {
				return err
			}
		}
		for _, g := range wanted {
			if err := q.AddChannelGroupMapping(r.Context(), store.AddChannelGroupMappingParams{ChannelID: c.ID, GroupName: g}); err != nil {
				return err
			}
		}
		return q.SetChannelGroupManaged(r.Context(), store.SetChannelGroupManagedParams{ID: c.ID, GroupManaged: in.Managed})
	})
	if err != nil {
		h.unavailable(w, r, "save channel groups", err)
		return
	}
	// Everyone the change may concern: people of old and new groups, and the
	// current members (a channel managed by groups drops the others).
	if err := h.reapply(r.Context(), append(append([]string{}, before...), wanted...), members); err != nil {
		h.unavailable(w, r, "apply channel groups", err)
		return
	}
	h.record(r, c.WorkspaceID, audit.ChannelGroupsSet, "channel", uuid(c.ID).String(),
		map[string]any{"groups": wanted, "managed": in.Managed})
	httpx.WriteJSON(w, http.StatusOK, api.ChannelGroups{Groups: append([]string{}, wanted...), Managed: in.Managed})
}

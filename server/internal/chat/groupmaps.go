// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"context"
	"net/http"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/audit"
	"github.com/Cenacle-TR/cenacle/server/internal/auth"
	"github.com/Cenacle-TR/cenacle/server/internal/groups"
	"github.com/Cenacle-TR/cenacle/server/internal/httpx"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
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
		// Only directory accounts follow the directory: bots, link guests and
		// people of federated servers have no profile there, and deactivated
		// people get no memberships back.
		if u.AuthService != auth.AuthService || u.IsBot || u.DeactivatedAt.Valid {
			continue
		}
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
		g := api.GroupMapping{Group: m.GroupName, Role: api.GroupMappingRole(m.Role)}
		if len(m.ReviewCandidates) > 0 {
			// Its group was renamed, but several groups had the name (ADR 0046).
			g.Candidates = &m.ReviewCandidates
		}
		out = append(out, g)
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
	reviews, err := h.channelGroupReviews(r.Context(), c.ID)
	if err != nil {
		h.unavailable(w, r, "list channel groups", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, api.ChannelGroups{Groups: append([]string{}, names...), Managed: c.GroupManaged, Reviews: &reviews})
}

// channelGroupReviews is the groups of a channel whose name changed at Cenacle
// ID when several groups had it (ADR 0046), with the names they may mean.
func (h *Handlers) channelGroupReviews(ctx context.Context, channel pgtype.UUID) ([]api.GroupReview, error) {
	rows, err := h.Queries.ListChannelGroupReviews(ctx, channel)
	if err != nil {
		return nil, err
	}
	out := make([]api.GroupReview, 0, len(rows))
	for _, r := range rows {
		out = append(out, api.GroupReview{Group: r.GroupName, Candidates: r.ReviewCandidates})
	}
	return out, nil
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
		// Groups that stay keep their review unless it is done.
		for _, g := range before {
			if slices.Contains(wanted, g) {
				continue
			}
			if _, err := q.DeleteChannelGroupMapping(r.Context(), store.DeleteChannelGroupMappingParams{ChannelID: c.ID, GroupName: g}); err != nil {
				return err
			}
		}
		for _, g := range wanted {
			if err := q.AddChannelGroupMapping(r.Context(), store.AddChannelGroupMappingParams{ChannelID: c.ID, GroupName: g}); err != nil {
				return err
			}
		}
		if in.Reviewed != nil {
			for _, g := range *in.Reviewed {
				if err := q.ClearChannelGroupReview(r.Context(), store.ClearChannelGroupReviewParams{ChannelID: c.ID, GroupName: g}); err != nil {
					return err
				}
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
	reviews, err := h.channelGroupReviews(r.Context(), c.ID)
	if err != nil {
		h.unavailable(w, r, "list channel groups", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, api.ChannelGroups{Groups: append([]string{}, wanted...), Managed: in.Managed, Reviews: &reviews})
}

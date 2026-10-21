// SPDX-License-Identifier: Apache-2.0

package chat

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/auth"
	"github.com/barisshn35/cenacle/server/internal/events"
	"github.com/barisshn35/cenacle/server/internal/httpx"
	"github.com/barisshn35/cenacle/server/internal/store"
)

// Problem codes of workspace operations.
const (
	CodeLastOwner        = "last_owner"
	CodeDefaultWorkspace = "default_workspace"
	CodeInviteInvalid    = "invite_invalid"
)

// WorkspaceEvent is the data of workspace.joined and workspace.left (for
// UserID) and workspace.updated / workspace.members_changed (for members).
type WorkspaceEvent struct {
	WorkspaceID string `json:"workspace_id"`
	UserID      string `json:"user_id,omitempty"`
}

func workspaceAPI(w store.Workspace, role string) api.Workspace {
	return api.Workspace{Id: uuid(w.ID), Name: w.Name, IsDefault: w.IsDefault, Role: api.WorkspaceRole(role)}
}

// ListWorkspaces implements api.ServerInterface.
func (h *Handlers) ListWorkspaces(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	rows, err := h.Queries.ListUserWorkspaces(r.Context(), p.User.ID)
	if err != nil {
		h.unavailable(w, r, "list workspaces", err)
		return
	}
	out := make([]api.Workspace, 0, len(rows))
	for _, row := range rows {
		out = append(out, workspaceAPI(row.Workspace, row.Role))
	}
	httpx.WriteJSON(w, http.StatusOK, struct {
		Workspaces []api.Workspace `json:"workspaces"`
	}{out})
}

// CreateWorkspace implements api.ServerInterface.
func (h *Handlers) CreateWorkspace(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	if !p.User.IsAdmin {
		forbidden(w, r, httpx.CodeForbidden, "Only the instance administrator can create workspaces.")
		return
	}
	var in struct {
		Name string `json:"name"`
	}
	if !decode(w, r, &in) {
		return
	}
	name, problem := cleanName(in.Name)
	if problem != "" {
		badRequest(w, r, "The workspace name is empty, longer than 80 characters or contains invalid characters.")
		return
	}
	ctx := r.Context()
	ws, err := h.Queries.CreateWorkspace(ctx, store.CreateWorkspaceParams{Name: name})
	if err == nil {
		_, err = h.Queries.AddWorkspaceMember(ctx, store.AddWorkspaceMemberParams{
			WorkspaceID: ws.ID, UserID: p.User.ID, Role: WorkspaceOwner,
		})
	}
	if err == nil {
		// Every workspace starts with a channel for everyone.
		var c store.Channel
		c, err = h.Queries.EnsureChannel(ctx, store.EnsureChannelParams{
			WorkspaceID: ws.ID, Name: "General", Topic: "", Kind: KindStandard, IsDefault: true,
		})
		if err == nil {
			_, err = h.Queries.AddAllUsers(ctx, c.ID)
		}
	}
	if err != nil {
		h.unavailable(w, r, "create workspace", err)
		return
	}
	h.publish(ctx, events.WorkspaceJoined, WorkspaceEvent{WorkspaceID: uuid(ws.ID).String(), UserID: uuid(p.User.ID).String()})
	httpx.WriteJSON(w, http.StatusCreated, workspaceAPI(ws, WorkspaceOwner))
}

// administeredWorkspace loads a workspace the user owns or administers.
func (h *Handlers) administeredWorkspace(w http.ResponseWriter, r *http.Request, id openapi_types.UUID, user store.User) (store.Workspace, string, bool) {
	role, ok := h.workspaceRole(w, r, id, user)
	if !ok {
		return store.Workspace{}, "", false
	}
	if !isWorkspaceAdmin(role) {
		forbidden(w, r, httpx.CodeForbidden, "Only the workspace's owners and admins can do this.")
		return store.Workspace{}, "", false
	}
	ws, err := h.Queries.GetWorkspace(r.Context(), pgUUID(id))
	if err != nil {
		h.unavailable(w, r, "get workspace", err)
		return ws, "", false
	}
	return ws, role, true
}

// RenameWorkspace implements api.ServerInterface.
func (h *Handlers) RenameWorkspace(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in struct {
		Name string `json:"name"`
	}
	if !decode(w, r, &in) {
		return
	}
	ws, role, ok := h.administeredWorkspace(w, r, workspaceID, p.User)
	if !ok {
		return
	}
	name, problem := cleanName(in.Name)
	if problem != "" {
		badRequest(w, r, "The workspace name is empty, longer than 80 characters or contains invalid characters.")
		return
	}
	ws, err := h.Queries.RenameWorkspace(r.Context(), store.RenameWorkspaceParams{ID: ws.ID, Name: name})
	if err != nil {
		h.unavailable(w, r, "rename workspace", err)
		return
	}
	h.publish(r.Context(), events.WorkspaceUpdated, WorkspaceEvent{WorkspaceID: uuid(ws.ID).String()})
	httpx.WriteJSON(w, http.StatusOK, workspaceAPI(ws, role))
}

func personAPI(id pgtype.UUID, name, email string) api.Person {
	return api.Person{Id: uuid(id), DisplayName: name, Email: email}
}

// ListWorkspaceMembers implements api.ServerInterface.
func (h *Handlers) ListWorkspaceMembers(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	if _, ok := h.workspaceRole(w, r, workspaceID, p.User); !ok {
		return
	}
	rows, err := h.Queries.ListWorkspaceMembers(r.Context(), pgUUID(workspaceID))
	if err != nil {
		h.unavailable(w, r, "list workspace members", err)
		return
	}
	out := make([]api.WorkspaceMember, 0, len(rows))
	for _, m := range rows {
		out = append(out, api.WorkspaceMember{
			User: personAPI(m.ID, m.DisplayName, m.Email), Role: api.WorkspaceMemberRole(m.Role),
		})
	}
	httpx.WriteJSON(w, http.StatusOK, struct {
		Members []api.WorkspaceMember `json:"members"`
	}{out})
}

func (h *Handlers) membersOfWorkspaceChanged(ctx context.Context, ws pgtype.UUID) {
	h.publish(ctx, events.WorkspaceMembersChanged, WorkspaceEvent{WorkspaceID: uuid(ws).String()})
}

// lastOwner reports whether the user is the only owner of the workspace.
func (h *Handlers) lastOwner(ctx context.Context, ws pgtype.UUID, role string) (bool, error) {
	if role != WorkspaceOwner {
		return false, nil
	}
	n, err := h.Queries.CountWorkspaceOwners(ctx, ws)
	return n <= 1, err
}

// SetWorkspaceRole implements api.ServerInterface.
func (h *Handlers) SetWorkspaceRole(w http.ResponseWriter, r *http.Request, workspaceID, userID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in struct {
		Role string `json:"role"`
	}
	if !decode(w, r, &in) {
		return
	}
	ws, myRole, ok := h.administeredWorkspace(w, r, workspaceID, p.User)
	if !ok {
		return
	}
	switch in.Role {
	case WorkspaceOwner, WorkspaceAdmin, WorkspaceMember:
	default:
		badRequest(w, r, "role must be owner, admin or member.")
		return
	}
	ctx := r.Context()
	target, err := h.Queries.GetWorkspaceRole(ctx, store.GetWorkspaceRoleParams{WorkspaceID: ws.ID, UserID: pgUUID(userID)})
	if err != nil {
		h.unavailable(w, r, "get workspace role", err)
		return
	}
	if target == "" {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound,
			Detail: "This person is not a member of the workspace."})
		return
	}
	// Only owners grant or take the owner role.
	if (in.Role == WorkspaceOwner || target == WorkspaceOwner) && myRole != WorkspaceOwner {
		forbidden(w, r, httpx.CodeForbidden, "Only owners can grant or take the owner role.")
		return
	}
	if in.Role != WorkspaceOwner {
		if last, err := h.lastOwner(ctx, ws.ID, target); err != nil {
			h.unavailable(w, r, "count owners", err)
			return
		} else if last {
			forbidden(w, r, CodeLastOwner, "A workspace keeps at least one owner.")
			return
		}
	}
	if _, err := h.Queries.SetWorkspaceRole(ctx, store.SetWorkspaceRoleParams{
		WorkspaceID: ws.ID, UserID: pgUUID(userID), Role: in.Role,
	}); err != nil {
		h.unavailable(w, r, "set workspace role", err)
		return
	}
	u, err := h.Queries.GetUser(ctx, pgUUID(userID))
	if err != nil {
		h.unavailable(w, r, "get user", err)
		return
	}
	h.membersOfWorkspaceChanged(ctx, ws.ID)
	// Rights in every channel of the workspace may have changed for them.
	h.publish(ctx, events.WorkspaceJoined, WorkspaceEvent{WorkspaceID: uuid(ws.ID).String(), UserID: uuid(u.ID).String()})
	httpx.WriteJSON(w, http.StatusOK, api.WorkspaceMember{
		User: personAPI(u.ID, u.DisplayName, u.Email), Role: api.WorkspaceMemberRole(in.Role),
	})
}

// RemoveWorkspaceMember implements api.ServerInterface.
func (h *Handlers) RemoveWorkspaceMember(w http.ResponseWriter, r *http.Request, workspaceID, userID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	myRole, ok := h.workspaceRole(w, r, workspaceID, p.User)
	if !ok {
		return
	}
	ctx := r.Context()
	self := pgUUID(userID) == p.User.ID
	if !self && !isWorkspaceAdmin(myRole) {
		forbidden(w, r, httpx.CodeForbidden, "Only the workspace's owners and admins can remove people.")
		return
	}
	ws, err := h.Queries.GetWorkspace(ctx, pgUUID(workspaceID))
	if err != nil {
		h.unavailable(w, r, "get workspace", err)
		return
	}
	if ws.IsDefault {
		forbidden(w, r, CodeDefaultWorkspace, "Everyone belongs to the default workspace.")
		return
	}
	target, err := h.Queries.GetWorkspaceRole(ctx, store.GetWorkspaceRoleParams{WorkspaceID: ws.ID, UserID: pgUUID(userID)})
	if err != nil {
		h.unavailable(w, r, "get workspace role", err)
		return
	}
	if target == "" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if target == WorkspaceOwner && !self && myRole != WorkspaceOwner {
		forbidden(w, r, httpx.CodeForbidden, "Only owners can remove an owner.")
		return
	}
	if last, err := h.lastOwner(ctx, ws.ID, target); err != nil {
		h.unavailable(w, r, "count owners", err)
		return
	} else if last {
		forbidden(w, r, CodeLastOwner, "A workspace keeps at least one owner.")
		return
	}
	if _, err := h.Queries.LeaveWorkspaceChannels(ctx, store.LeaveWorkspaceChannelsParams{WorkspaceID: ws.ID, UserID: pgUUID(userID)}); err != nil {
		h.unavailable(w, r, "leave workspace channels", err)
		return
	}
	if _, err := h.Queries.RemoveWorkspaceMember(ctx, store.RemoveWorkspaceMemberParams{WorkspaceID: ws.ID, UserID: pgUUID(userID)}); err != nil {
		h.unavailable(w, r, "remove workspace member", err)
		return
	}
	h.publish(ctx, events.WorkspaceLeft, WorkspaceEvent{WorkspaceID: uuid(ws.ID).String(), UserID: uuid(pgUUID(userID)).String()})
	h.membersOfWorkspaceChanged(ctx, ws.ID)
	w.WriteHeader(http.StatusNoContent)
}

// --- invitations -------------------------------------------------------------

// Invitation lifetimes (hours).
const (
	defaultInviteHours = 7 * 24
	maxInviteHours     = 30 * 24
)

func inviteAPI(i store.WorkspaceInvite) api.Invite {
	out := api.Invite{Id: uuid(i.ID), CreatedAt: i.CreatedAt, ExpiresAt: i.ExpiresAt, Uses: int(i.Uses)}
	if i.MaxUses.Valid {
		n := int(i.MaxUses.Int32)
		out.MaxUses = &n
	}
	return out
}

func hashInvite(token string) []byte {
	h := sha256.Sum256([]byte(token))
	return h[:]
}

// ListInvites implements api.ServerInterface.
func (h *Handlers) ListInvites(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	ws, _, ok := h.administeredWorkspace(w, r, workspaceID, p.User)
	if !ok {
		return
	}
	rows, err := h.Queries.ListInvites(r.Context(), ws.ID)
	if err != nil {
		h.unavailable(w, r, "list invites", err)
		return
	}
	out := make([]api.Invite, 0, len(rows))
	for _, i := range rows {
		out = append(out, inviteAPI(i))
	}
	httpx.WriteJSON(w, http.StatusOK, struct {
		Invites []api.Invite `json:"invites"`
	}{out})
}

// CreateInvite implements api.ServerInterface.
func (h *Handlers) CreateInvite(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in struct {
		ExpiresInHours *int `json:"expires_in_hours"`
		MaxUses        *int `json:"max_uses"`
	}
	if !decode(w, r, &in) {
		return
	}
	ws, _, ok := h.administeredWorkspace(w, r, workspaceID, p.User)
	if !ok {
		return
	}
	hours := defaultInviteHours
	if in.ExpiresInHours != nil {
		hours = *in.ExpiresInHours
	}
	if hours < 1 || hours > maxInviteHours || (in.MaxUses != nil && (*in.MaxUses < 1 || *in.MaxUses > 1000)) {
		badRequest(w, r, "expires_in_hours must be 1 to 720 and max_uses 1 to 1000.")
		return
	}
	var maxUses pgtype.Int4
	if in.MaxUses != nil {
		maxUses = pgtype.Int4{Int32: int32(*in.MaxUses), Valid: true} //nolint:gosec // checked: 1 to 1000
	}
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	token := base64.RawURLEncoding.EncodeToString(b)
	inv, err := h.Queries.CreateInvite(r.Context(), store.CreateInviteParams{
		WorkspaceID: ws.ID, TokenHash: hashInvite(token), CreatedBy: p.User.ID,
		ExpiresAt: time.Now().Add(time.Duration(hours) * time.Hour), MaxUses: maxUses,
	})
	if err != nil {
		h.unavailable(w, r, "create invite", err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, struct {
		Invite api.Invite `json:"invite"`
		Token  string     `json:"token"`
	}{inviteAPI(inv), token})
}

// RevokeInvite implements api.ServerInterface.
func (h *Handlers) RevokeInvite(w http.ResponseWriter, r *http.Request, workspaceID, inviteID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	ws, _, ok := h.administeredWorkspace(w, r, workspaceID, p.User)
	if !ok {
		return
	}
	if _, err := h.Queries.RevokeInvite(r.Context(), store.RevokeInviteParams{ID: pgUUID(inviteID), WorkspaceID: ws.ID}); err != nil {
		h.unavailable(w, r, "revoke invite", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// invite loads an invitation by its token, or answers 404.
func (h *Handlers) invite(w http.ResponseWriter, r *http.Request, token string) (store.GetInviteByHashRow, bool) {
	row, err := h.Queries.GetInviteByHash(r.Context(), hashInvite(token))
	if isNoRows(err) || len(token) > 100 {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: CodeInviteInvalid,
			Detail: "This invitation does not exist."})
		return row, false
	}
	if err != nil {
		h.unavailable(w, r, "get invite", err)
		return row, false
	}
	return row, true
}

func inviteValid(i store.WorkspaceInvite) bool {
	return !i.RevokedAt.Valid && i.ExpiresAt.After(time.Now()) && (!i.MaxUses.Valid || i.Uses < i.MaxUses.Int32)
}

// GetInvite implements api.ServerInterface.
func (h *Handlers) GetInvite(w http.ResponseWriter, r *http.Request, token string) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	row, ok := h.invite(w, r, token)
	if !ok {
		return
	}
	role, err := h.Queries.GetWorkspaceRole(r.Context(), store.GetWorkspaceRoleParams{
		WorkspaceID: row.WorkspaceInvite.WorkspaceID, UserID: p.User.ID,
	})
	if err != nil {
		h.unavailable(w, r, "get workspace role", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, api.InvitePreview{
		WorkspaceId: uuid(row.WorkspaceInvite.WorkspaceID), WorkspaceName: row.WorkspaceName,
		Valid: inviteValid(row.WorkspaceInvite), IsMember: role != "",
	})
}

// AcceptInvite implements api.ServerInterface.
func (h *Handlers) AcceptInvite(w http.ResponseWriter, r *http.Request, token string) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	row, ok := h.invite(w, r, token)
	if !ok {
		return
	}
	ctx := r.Context()
	wsID := row.WorkspaceInvite.WorkspaceID
	role, err := h.Queries.GetWorkspaceRole(ctx, store.GetWorkspaceRoleParams{WorkspaceID: wsID, UserID: p.User.ID})
	if err != nil {
		h.unavailable(w, r, "get workspace role", err)
		return
	}
	if role == "" {
		// Counting the use first makes the limit hold under concurrent accepts.
		if _, err := h.Queries.UseInvite(ctx, row.WorkspaceInvite.ID); isNoRows(err) {
			httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusGone, Code: CodeInviteInvalid,
				Detail: "This invitation has expired, been used up or revoked."})
			return
		} else if err != nil {
			h.unavailable(w, r, "use invite", err)
			return
		}
		if _, err := h.Queries.AddWorkspaceMember(ctx, store.AddWorkspaceMemberParams{
			WorkspaceID: wsID, UserID: p.User.ID, Role: WorkspaceMember,
		}); err != nil {
			h.unavailable(w, r, "join workspace", err)
			return
		}
		if _, err := h.Queries.JoinDefaultChannels(ctx, p.User.ID); err != nil {
			h.unavailable(w, r, "join default channels", err)
			return
		}
		role = WorkspaceMember
		h.publish(ctx, events.WorkspaceJoined, WorkspaceEvent{WorkspaceID: uuid(wsID).String(), UserID: uuid(p.User.ID).String()})
		h.membersOfWorkspaceChanged(ctx, wsID)
	}
	ws, err := h.Queries.GetWorkspace(ctx, wsID)
	if err != nil {
		h.unavailable(w, r, "get workspace", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, workspaceAPI(ws, role))
}

// SetChannelMemberRole implements api.ServerInterface.
func (h *Handlers) SetChannelMemberRole(w http.ResponseWriter, r *http.Request, channelID, userID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in struct {
		Role string `json:"role"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.Role != RoleMember && in.Role != RoleManager {
		badRequest(w, r, "role must be member or manager.")
		return
	}
	c, ok := h.managedChannel(w, r, channelID, p.User)
	if !ok {
		return
	}
	n, err := h.Queries.SetChannelMemberRole(r.Context(), store.SetChannelMemberRoleParams{
		ChannelID: c.ID, UserID: pgUUID(userID), Role: in.Role,
	})
	if err != nil {
		h.unavailable(w, r, "set channel role", err)
		return
	}
	if n == 0 {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound,
			Detail: "This person is not a member of the channel."})
		return
	}
	u, err := h.Queries.GetUser(r.Context(), pgUUID(userID))
	if err != nil {
		h.unavailable(w, r, "get user", err)
		return
	}
	h.publish(r.Context(), events.ChannelMembersChanged, ChannelEvent{ChannelID: uuid(c.ID).String()})
	// Their rights in the channel changed: their channel list reloads.
	h.publish(r.Context(), events.ChannelJoined, ChannelEvent{
		Channel: toAPI(c, access{ch: in.Role}), UserID: uuid(u.ID).String(),
	})
	httpx.WriteJSON(w, http.StatusOK, api.Member{User: personAPI(u.ID, u.DisplayName, u.Email), Role: api.MemberRole(in.Role)})
}

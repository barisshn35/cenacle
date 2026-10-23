// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"context"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/audit"
	"github.com/barisshn35/cenacle/server/internal/auth"
	"github.com/barisshn35/cenacle/server/internal/events"
	"github.com/barisshn35/cenacle/server/internal/httpx"
	"github.com/barisshn35/cenacle/server/internal/store"
)

// Problem codes of groups.
const (
	CodeHandleTaken  = "handle_taken"
	CodeLastManager  = "last_manager"
	CodeDirectoryRun = "directory_group"
)

var (
	// A group's handle: lower-case letters, digits and . _ - inside.
	handleRE = regexp.MustCompile(`^[a-z0-9]([a-z0-9._-]{0,28}[a-z0-9])?$`)
	// Group mentions in a text: @handle, not inside a word, an address or <@id>.
	groupMentionRE = regexp.MustCompile(`(?i)(?:^|[^\w@<])@([a-z0-9](?:[a-z0-9._-]{0,28}[a-z0-9])?)`)
	// Words that mention many already, so no group can be called so.
	reservedHandles = map[string]bool{"channel": true, "everyone": true, "here": true, "admins": true, "owners": true, "all": true}
)

// GroupsEvent is the data of groups.changed: a workspace's groups or their
// members changed.
type GroupsEvent struct {
	WorkspaceID string `json:"workspace_id"`
}

// groupHandles returns the group handles a text mentions, each once.
func groupHandles(body string) []string {
	var out []string
	seen := map[string]bool{}
	for _, m := range groupMentionRE.FindAllStringSubmatch(body, -1) {
		h := strings.ToLower(m[1])
		if reservedHandles[h] || seen[h] {
			continue
		}
		seen[h] = true
		out = append(out, h)
	}
	return out
}

// addGroupMentions records a mention for each person a message's group
// mentions reach in its channel.
func addGroupMentions(ctx context.Context, q *store.Queries, c store.Channel, msg store.Message) error {
	handles := groupHandles(msg.Body)
	if len(handles) == 0 {
		return nil
	}
	return q.AddGroupMentions(ctx, store.AddGroupMentionsParams{
		MessageID: msg.ID, ChannelID: c.ID, WorkspaceID: c.WorkspaceID, Handles: handles, AuthorID: msg.AuthorID,
	})
}

func isAdminRole(role string) bool { return role == "owner" || role == "admin" }

func groupAPI(g store.MentionGroup, members int, member, manager bool, role string) api.MentionGroup {
	out := api.MentionGroup{
		Id: uuid(g.ID), Handle: g.Handle, Name: g.Name, Description: g.Description,
		MemberCount: members, IsMember: member, Archived: g.ArchivedAt.Valid,
		// Directory groups are the administrators'; their own groups, the managers'.
		CanManage: isAdminRole(role) || (manager && !g.DirectoryGroup.Valid),
	}
	if g.DirectoryGroup.Valid {
		out.DirectoryGroup = &g.DirectoryGroup.String
	}
	return out
}

// cleanGroup checks a group's handle, name and description (each optional).
func cleanGroup(handle, name, description *string) (pgtype.Text, pgtype.Text, pgtype.Text, string) {
	var h, n, d pgtype.Text
	if handle != nil {
		v := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(*handle), "@"))
		if !handleRE.MatchString(v) {
			return h, n, d, "A handle has 1 to 30 lower-case letters, digits, dots, dashes or underscores, and starts and ends with a letter or digit."
		}
		if reservedHandles[v] {
			return h, n, d, "@" + v + " already mentions many; choose another handle."
		}
		h = pgtype.Text{String: v, Valid: true}
	}
	if name != nil {
		v := strings.Join(strings.Fields(*name), " ")
		if v == "" || utf8.RuneCountInString(v) > 64 {
			return h, n, d, "A group's name has 1 to 64 characters."
		}
		n = pgtype.Text{String: v, Valid: true}
	}
	if description != nil {
		v := strings.TrimSpace(*description)
		if utf8.RuneCountInString(v) > 500 {
			return h, n, d, "The description is longer than 500 characters."
		}
		d = pgtype.Text{String: v, Valid: true}
	}
	return h, n, d, ""
}

func (h *Handlers) groupsChanged(ctx context.Context, workspace pgtype.UUID) {
	h.publish(ctx, events.GroupsChanged, GroupsEvent{WorkspaceID: uuid(workspace).String()})
}

// ListGroups implements api.ServerInterface.
func (h *Handlers) ListGroups(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	role, ok := h.workspaceRole(w, r, workspaceID, p.User)
	if !ok {
		return
	}
	ctx := r.Context()
	rows, err := h.Queries.ListMentionGroups(ctx, store.ListMentionGroupsParams{
		WorkspaceID: pgUUID(workspaceID), UserID: p.User.ID,
	})
	if err != nil {
		h.unavailable(w, r, "list groups", err)
		return
	}
	creation, err := h.Queries.GetGroupCreation(ctx, pgUUID(workspaceID))
	if err != nil {
		h.unavailable(w, r, "group settings", err)
		return
	}
	out := struct {
		Groups    []api.MentionGroup `json:"groups"`
		CanCreate bool               `json:"can_create"`
		Creation  string             `json:"creation"`
	}{Groups: []api.MentionGroup{}, Creation: creation,
		CanCreate: isAdminRole(role) || (role != "guest" && creation == "members")}
	for _, g := range rows {
		group := store.MentionGroup{ID: g.ID, WorkspaceID: g.WorkspaceID, Handle: g.Handle, Name: g.Name,
			Description: g.Description, DirectoryGroup: g.DirectoryGroup, ArchivedAt: g.ArchivedAt}
		out.Groups = append(out.Groups, groupAPI(group, int(g.MemberCount), g.IsMember, g.IsManager, role))
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// CreateGroup implements api.ServerInterface.
func (h *Handlers) CreateGroup(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.CreateGroupJSONBody
	if !decode(w, r, &in) {
		return
	}
	role, ok := h.workspaceRole(w, r, workspaceID, p.User)
	if !ok {
		return
	}
	ctx := r.Context()
	ws := pgUUID(workspaceID)
	creation, err := h.Queries.GetGroupCreation(ctx, ws)
	if err != nil {
		h.unavailable(w, r, "group settings", err)
		return
	}
	if !isAdminRole(role) && (role == "guest" || creation != "members") {
		forbidden(w, r, httpx.CodeForbidden, "Only the workspace's administrators can create groups.")
		return
	}
	handle, name, description, problem := cleanGroup(&in.Handle, &in.Name, in.Description)
	if problem != "" {
		badRequest(w, r, problem)
		return
	}
	var directory pgtype.Text
	if in.DirectoryGroup != nil {
		if !isAdminRole(role) {
			forbidden(w, r, httpx.CodeForbidden, "Only the workspace's administrators can make a group follow a directory group.")
			return
		}
		directory = pgtype.Text{String: strings.TrimSpace(*in.DirectoryGroup), Valid: true}
		if directory.String == "" {
			badRequest(w, r, "Name the directory group.")
			return
		}
	}
	var g store.MentionGroup
	err = h.inTx(ctx, func(q *store.Queries) error {
		var err error
		g, err = q.CreateMentionGroup(ctx, store.CreateMentionGroupParams{
			WorkspaceID: ws, Handle: handle.String, Name: name.String, Description: description.String,
			DirectoryGroup: directory, CreatedBy: p.User.ID,
		})
		if err != nil || directory.Valid {
			return err
		}
		// The creator manages the group.
		if err := q.AddMentionGroupMembers(ctx, store.AddMentionGroupMembersParams{
			GroupID: g.ID, UserIds: []pgtype.UUID{p.User.ID}, Manager: true,
		}); err != nil {
			return err
		}
		if in.MemberIds == nil {
			return nil
		}
		return q.AddMentionGroupMembers(ctx, store.AddMentionGroupMembersParams{
			GroupID: g.ID, UserIds: uuidsOf(*in.MemberIds),
		})
	})
	if isUniqueViolation(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeHandleTaken,
			Detail: "A group of this workspace already has the handle @" + handle.String + "."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "create group", err)
		return
	}
	h.record(r, ws, audit.MentionGroupChanged, "group", uuid(g.ID).String(), map[string]any{"handle": g.Handle, "created": true})
	h.groupsChanged(ctx, ws)
	h.writeGroup(w, r, http.StatusCreated, g, p.User, role)
}

// writeGroup answers with a group as the user sees it.
func (h *Handlers) writeGroup(w http.ResponseWriter, r *http.Request, status int, g store.MentionGroup, user store.User, role string) {
	rows, err := h.Queries.ListMentionGroups(r.Context(), store.ListMentionGroupsParams{
		WorkspaceID: g.WorkspaceID, UserID: user.ID,
	})
	if err != nil {
		h.unavailable(w, r, "list groups", err)
		return
	}
	for _, row := range rows {
		if row.ID == g.ID {
			httpx.WriteJSON(w, status, groupAPI(g, int(row.MemberCount), row.IsMember, row.IsManager, role))
			return
		}
	}
	httpx.WriteJSON(w, status, groupAPI(g, 0, false, false, role))
}

// SetGroupCreation implements api.ServerInterface.
func (h *Handlers) SetGroupCreation(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.SetGroupCreationJSONBody
	if !decode(w, r, &in) {
		return
	}
	if in.Creation != api.SetGroupCreationJSONBodyCreationMembers && in.Creation != api.SetGroupCreationJSONBodyCreationAdmins {
		badRequest(w, r, "creation is members or admins.")
		return
	}
	ws, _, ok := h.administeredWorkspace(w, r, workspaceID, p.User)
	if !ok {
		return
	}
	if err := h.Queries.SetGroupCreation(r.Context(), store.SetGroupCreationParams{ID: ws.ID, GroupCreation: string(in.Creation)}); err != nil {
		h.unavailable(w, r, "group settings", err)
		return
	}
	h.record(r, ws.ID, audit.MentionGroupChanged, "workspace", uuid(ws.ID).String(), map[string]any{"creation": in.Creation})
	h.groupsChanged(r.Context(), ws.ID)
	w.WriteHeader(http.StatusNoContent)
}

// group loads a group of one of the user's workspaces, with the user's role
// there and whether they manage the group.
func (h *Handlers) group(w http.ResponseWriter, r *http.Request, id openapi_types.UUID, user store.User) (store.MentionGroup, string, bool, bool) {
	g, err := h.Queries.GetMentionGroup(r.Context(), pgUUID(id))
	if isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No such group."})
		return g, "", false, false
	} else if err != nil {
		h.unavailable(w, r, "get group", err)
		return g, "", false, false
	}
	role, ok := h.workspaceRole(w, r, uuid(g.WorkspaceID), user)
	if !ok {
		return g, "", false, false
	}
	people, err := h.Queries.ListMentionGroupPeople(r.Context(), g.ID)
	if err != nil {
		h.unavailable(w, r, "list group", err)
		return g, "", false, false
	}
	manages := false
	for _, person := range people {
		if person.ID == user.ID && person.Manager {
			manages = true
		}
	}
	return g, role, isAdminRole(role) || (manages && !g.DirectoryGroup.Valid), true
}

// GetGroup implements api.ServerInterface.
func (h *Handlers) GetGroup(w http.ResponseWriter, r *http.Request, groupID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	g, role, manages, ok := h.group(w, r, groupID, p.User)
	if !ok {
		return
	}
	people, err := h.Queries.ListMentionGroupPeople(r.Context(), g.ID)
	if err != nil {
		h.unavailable(w, r, "list group", err)
		return
	}
	member := false
	members := make([]api.MentionGroupMember, 0, len(people))
	for _, person := range people {
		if person.ID == p.User.ID {
			member = true
		}
		members = append(members, api.MentionGroupMember{
			Person: personAPI(person.ID, person.DisplayName, person.Email, person.IsBot), Manager: person.Manager,
		})
	}
	// Guests see the people of the groups they are in only.
	if role == "guest" && !member {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No such group."})
		return
	}
	out := groupAPI(g, len(people), member, manages, role)
	out.CanManage = manages
	httpx.WriteJSON(w, http.StatusOK, struct {
		Group   api.MentionGroup         `json:"group"`
		Members []api.MentionGroupMember `json:"members"`
	}{out, members})
}

// UpdateGroup implements api.ServerInterface.
func (h *Handlers) UpdateGroup(w http.ResponseWriter, r *http.Request, groupID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.UpdateGroupJSONBody
	if !decode(w, r, &in) {
		return
	}
	g, role, manages, ok := h.group(w, r, groupID, p.User)
	if !ok {
		return
	}
	if !manages {
		forbidden(w, r, httpx.CodeForbidden, "Only the group's managers and the workspace's administrators can change it.")
		return
	}
	handle, name, description, problem := cleanGroup(in.Handle, in.Name, in.Description)
	if problem != "" {
		badRequest(w, r, problem)
		return
	}
	params := store.UpdateMentionGroupParams{ID: g.ID, Handle: handle, Name: name, Description: description}
	if in.Archived != nil {
		params.Archived = pgtype.Bool{Bool: *in.Archived, Valid: true}
	}
	updated, err := h.Queries.UpdateMentionGroup(r.Context(), params)
	if isUniqueViolation(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeHandleTaken,
			Detail: "A group of this workspace already has the handle @" + handle.String + "."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "update group", err)
		return
	}
	detail := map[string]any{"handle": updated.Handle}
	if in.Archived != nil {
		detail["archived"] = *in.Archived
	}
	h.record(r, g.WorkspaceID, audit.MentionGroupChanged, "group", uuid(g.ID).String(), detail)
	h.groupsChanged(r.Context(), g.WorkspaceID)
	h.writeGroup(w, r, http.StatusOK, updated, p.User, role)
}

// AddGroupMembers implements api.ServerInterface.
func (h *Handlers) AddGroupMembers(w http.ResponseWriter, r *http.Request, groupID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.AddGroupMembersJSONBody
	if !decode(w, r, &in) {
		return
	}
	g, _, manages, ok := h.group(w, r, groupID, p.User)
	if !ok {
		return
	}
	if g.DirectoryGroup.Valid {
		forbidden(w, r, CodeDirectoryRun, "This group has the people of its directory group; change them in the directory.")
		return
	}
	if !manages {
		forbidden(w, r, httpx.CodeForbidden, "Only the group's managers and the workspace's administrators can add people.")
		return
	}
	if len(in.UserIds) == 0 || len(in.UserIds) > 500 {
		badRequest(w, r, "Add 1 to 500 people at a time.")
		return
	}
	if err := h.Queries.AddMentionGroupMembers(r.Context(), store.AddMentionGroupMembersParams{
		GroupID: g.ID, UserIds: uuidsOf(in.UserIds),
	}); err != nil {
		h.unavailable(w, r, "add to group", err)
		return
	}
	h.record(r, g.WorkspaceID, audit.MentionGroupChanged, "group", uuid(g.ID).String(), map[string]any{"added": len(in.UserIds)})
	h.groupsChanged(r.Context(), g.WorkspaceID)
	w.WriteHeader(http.StatusNoContent)
}

// lastManager tells whether a member is the group's only manager while
// others are in it.
func (h *Handlers) lastManager(ctx context.Context, g store.MentionGroup, user pgtype.UUID) (bool, error) {
	people, err := h.Queries.ListMentionGroupPeople(ctx, g.ID)
	if err != nil {
		return false, err
	}
	managers, isManager := 0, false
	for _, person := range people {
		if person.Manager {
			managers++
			isManager = isManager || person.ID == user
		}
	}
	return isManager && managers == 1 && len(people) > 1, nil
}

// RemoveGroupMember implements api.ServerInterface.
func (h *Handlers) RemoveGroupMember(w http.ResponseWriter, r *http.Request, groupID, userID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	g, _, manages, ok := h.group(w, r, groupID, p.User)
	if !ok {
		return
	}
	self := pgUUID(userID) == p.User.ID
	if g.DirectoryGroup.Valid {
		forbidden(w, r, CodeDirectoryRun, "This group has the people of its directory group; change them in the directory.")
		return
	}
	if !self && !manages {
		forbidden(w, r, httpx.CodeForbidden, "Only the group's managers and the workspace's administrators can remove people.")
		return
	}
	last, err := h.lastManager(r.Context(), g, pgUUID(userID))
	if err != nil {
		h.unavailable(w, r, "list group", err)
		return
	}
	if last {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeLastManager,
			Detail: "The group needs a manager: make someone else a manager first."})
		return
	}
	n, err := h.Queries.RemoveMentionGroupMember(r.Context(), store.RemoveMentionGroupMemberParams{GroupID: g.ID, UserID: pgUUID(userID)})
	if err != nil {
		h.unavailable(w, r, "remove from group", err)
		return
	}
	if n == 0 {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "Not a member of this group."})
		return
	}
	h.record(r, g.WorkspaceID, audit.MentionGroupChanged, "group", uuid(g.ID).String(), map[string]any{"removed": userID.String()})
	h.groupsChanged(r.Context(), g.WorkspaceID)
	w.WriteHeader(http.StatusNoContent)
}

// SetGroupManager implements api.ServerInterface.
func (h *Handlers) SetGroupManager(w http.ResponseWriter, r *http.Request, groupID, userID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in struct {
		Manager bool `json:"manager"`
	}
	if !decode(w, r, &in) {
		return
	}
	g, _, manages, ok := h.group(w, r, groupID, p.User)
	if !ok {
		return
	}
	if !manages || g.DirectoryGroup.Valid {
		forbidden(w, r, httpx.CodeForbidden, "Only the group's managers and the workspace's administrators can choose its managers.")
		return
	}
	if !in.Manager {
		last, err := h.lastManager(r.Context(), g, pgUUID(userID))
		if err != nil {
			h.unavailable(w, r, "list group", err)
			return
		}
		if last {
			httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeLastManager,
				Detail: "The group needs a manager: make someone else a manager first."})
			return
		}
	}
	n, err := h.Queries.SetMentionGroupManager(r.Context(), store.SetMentionGroupManagerParams{
		GroupID: g.ID, UserID: pgUUID(userID), Manager: in.Manager,
	})
	if err != nil {
		h.unavailable(w, r, "set manager", err)
		return
	}
	if n == 0 {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "Not a member of this group."})
		return
	}
	h.record(r, g.WorkspaceID, audit.MentionGroupChanged, "group", uuid(g.ID).String(), map[string]any{"manager": userID.String(), "is_manager": in.Manager})
	h.groupsChanged(r.Context(), g.WorkspaceID)
	w.WriteHeader(http.StatusNoContent)
}

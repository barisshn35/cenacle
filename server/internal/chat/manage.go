// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/audit"
	"github.com/Cenacle-TR/cenacle/server/internal/auth"
	"github.com/Cenacle-TR/cenacle/server/internal/events"
	"github.com/Cenacle-TR/cenacle/server/internal/httpx"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

// RestoreWindow is how long a deleted message can be brought back.
const RestoreWindow = 5 * time.Minute

func (h *Handlers) configured(name string) bool {
	for _, n := range h.Configured {
		if strings.EqualFold(n, name) {
			return true
		}
	}
	return false
}

// --- archiving -------------------------------------------------------------

func (h *Handlers) setArchived(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID, archived bool) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	c, role, ok := h.visibleChannel(w, r, channelID, p.User)
	if !ok {
		return
	}
	if !canManage(c, role) {
		forbidden(w, r, httpx.CodeForbidden, "Only the channel's managers can archive it.")
		return
	}
	if c.IsMandatory {
		forbidden(w, r, CodeChannelMandatory, "Everyone is a member of this channel; it cannot be archived.")
		return
	}
	c, err := h.Queries.SetChannelArchived(r.Context(), store.SetChannelArchivedParams{ID: c.ID, Archived: archived})
	if err != nil {
		h.unavailable(w, r, "archive channel", err)
		return
	}
	action := audit.ChannelArchived
	if !archived {
		action = audit.ChannelUnarchived
	}
	h.record(r, c.WorkspaceID, action, "channel", uuid(c.ID).String(), map[string]any{"channel": c.Name})
	h.publish(r.Context(), events.ChannelUpdated, ChannelEvent{
		Channel: toAPI(c, access{ch: RoleMember}), ChannelID: uuid(c.ID).String(),
	})
	httpx.WriteJSON(w, http.StatusOK, toAPI(c, role))
}

// ArchiveChannel implements api.ServerInterface.
func (h *Handlers) ArchiveChannel(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID) {
	h.setArchived(w, r, channelID, true)
}

// UnarchiveChannel implements api.ServerInterface.
func (h *Handlers) UnarchiveChannel(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID) {
	h.setArchived(w, r, channelID, false)
}

// --- categories ------------------------------------------------------------

func categoryAPI(c store.ChannelCategory) api.Category {
	return api.Category{Id: uuid(c.ID), Name: c.Name, Position: int(c.Position)}
}

func (h *Handlers) categoriesChanged(ctx context.Context, workspaceID pgtype.UUID) {
	h.publish(ctx, events.CategoriesChanged, WorkspaceRef{WorkspaceID: uuid(workspaceID).String()})
}

// WorkspaceRef is the data of events about a workspace as a whole.
type WorkspaceRef struct {
	WorkspaceID string `json:"workspace_id"`
}

func categoryNotFound(w http.ResponseWriter, r *http.Request) {
	httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound,
		Detail: "No category with this id."})
}

// mayOrganize answers 403 unless the role may organize the workspace's
// categories (its permission scheme).
func (h *Handlers) mayOrganize(w http.ResponseWriter, r *http.Request, workspaceID pgtype.UUID, role string) bool {
	ws, err := h.Queries.GetWorkspace(r.Context(), workspaceID)
	if err != nil {
		h.unavailable(w, r, "get workspace", err)
		return false
	}
	if !permissionsOf(ws.Permissions).Allows(PermCategories, role) {
		forbidden(w, r, httpx.CodeForbidden, "Your role in this workspace does not organize categories.")
		return false
	}
	return true
}

// managedCategory loads a category of a workspace the user administers.
func (h *Handlers) managedCategory(w http.ResponseWriter, r *http.Request, id openapi_types.UUID, user store.User) (store.ChannelCategory, bool) {
	c, err := h.Queries.GetCategory(r.Context(), pgUUID(id))
	if isNoRows(err) {
		categoryNotFound(w, r)
		return c, false
	}
	if err != nil {
		h.unavailable(w, r, "get category", err)
		return c, false
	}
	role, err := h.Queries.GetWorkspaceRole(r.Context(), store.GetWorkspaceRoleParams{WorkspaceID: c.WorkspaceID, UserID: user.ID})
	if err != nil {
		h.unavailable(w, r, "get workspace role", err)
		return c, false
	}
	if role == "" {
		categoryNotFound(w, r)
		return c, false
	}
	return c, h.mayOrganize(w, r, c.WorkspaceID, role)
}

// ListCategories implements api.ServerInterface.
func (h *Handlers) ListCategories(w http.ResponseWriter, r *http.Request, params api.ListCategoriesParams) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	if _, ok := h.workspaceRole(w, r, params.WorkspaceId, p.User); !ok {
		return
	}
	rows, err := h.Queries.ListCategories(r.Context(), pgUUID(params.WorkspaceId))
	if err != nil {
		h.unavailable(w, r, "list categories", err)
		return
	}
	out := make([]api.Category, 0, len(rows))
	for _, c := range rows {
		out = append(out, categoryAPI(c))
	}
	httpx.WriteJSON(w, http.StatusOK, struct {
		Categories []api.Category `json:"categories"`
	}{out})
}

// CreateCategory implements api.ServerInterface.
func (h *Handlers) CreateCategory(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in struct {
		WorkspaceID openapi_types.UUID `json:"workspace_id"`
		Name        string             `json:"name"`
	}
	if !decode(w, r, &in) {
		return
	}
	role, ok := h.workspaceRole(w, r, in.WorkspaceID, p.User)
	if !ok || !h.mayOrganize(w, r, pgUUID(in.WorkspaceID), role) {
		return
	}
	name, problem := cleanName(in.Name)
	if problem != "" {
		badRequest(w, r, strings.Replace(problem, "channel", "category", 1))
		return
	}
	c, err := h.Queries.CreateCategory(r.Context(), store.CreateCategoryParams{WorkspaceID: pgUUID(in.WorkspaceID), Name: name})
	if isUniqueViolation(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeNameTaken,
			Detail: "A category with this name exists."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "create category", err)
		return
	}
	h.categoriesChanged(r.Context(), c.WorkspaceID)
	httpx.WriteJSON(w, http.StatusCreated, categoryAPI(c))
}

// UpdateCategory implements api.ServerInterface.
func (h *Handlers) UpdateCategory(w http.ResponseWriter, r *http.Request, categoryID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in struct {
		Name     *string `json:"name"`
		Position *int    `json:"position"`
	}
	if !decode(w, r, &in) {
		return
	}
	c, ok := h.managedCategory(w, r, categoryID, p.User)
	if !ok {
		return
	}
	name, position := c.Name, c.Position
	if in.Name != nil {
		var problem string
		if name, problem = cleanName(*in.Name); problem != "" {
			badRequest(w, r, strings.Replace(problem, "channel", "category", 1))
			return
		}
	}
	if in.Position != nil {
		if *in.Position < -1_000_000 || *in.Position > 1_000_000 {
			badRequest(w, r, "position is out of range.")
			return
		}
		position = int32(*in.Position)
	}
	c, err := h.Queries.UpdateCategory(r.Context(), store.UpdateCategoryParams{ID: c.ID, Name: name, Position: position})
	if isUniqueViolation(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeNameTaken,
			Detail: "A category with this name exists."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "update category", err)
		return
	}
	h.categoriesChanged(r.Context(), c.WorkspaceID)
	httpx.WriteJSON(w, http.StatusOK, categoryAPI(c))
}

// DeleteCategory implements api.ServerInterface.
func (h *Handlers) DeleteCategory(w http.ResponseWriter, r *http.Request, categoryID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	c, ok := h.managedCategory(w, r, categoryID, p.User)
	if !ok {
		return
	}
	if _, err := h.Queries.DeleteCategory(r.Context(), c.ID); err != nil {
		h.unavailable(w, r, "delete category", err)
		return
	}
	h.categoriesChanged(r.Context(), c.WorkspaceID)
	w.WriteHeader(http.StatusNoContent)
}

// SetChannelCategory implements api.ServerInterface.
func (h *Handlers) SetChannelCategory(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in struct {
		CategoryID *openapi_types.UUID `json:"category_id"`
	}
	if !decode(w, r, &in) {
		return
	}
	c, role, ok := h.visibleChannel(w, r, channelID, p.User)
	if ok && isConversation(c) {
		forbidden(w, r, httpx.CodeForbidden, "Conversations have no category.")
		return
	}
	if !ok || !h.mayOrganize(w, r, c.WorkspaceID, role.ws) {
		return
	}
	category := c.CategoryID
	category.Valid = in.CategoryID != nil
	if in.CategoryID != nil {
		cat, err := h.Queries.GetCategory(r.Context(), pgUUID(*in.CategoryID))
		if isNoRows(err) || (err == nil && cat.WorkspaceID != c.WorkspaceID) {
			badRequest(w, r, "No category with this id in the channel's workspace.")
			return
		}
		if err != nil {
			h.unavailable(w, r, "get category", err)
			return
		}
		category = cat.ID
	}
	c, err := h.Queries.UpdateChannel(r.Context(), store.UpdateChannelParams{
		ID: c.ID, Name: c.Name, Visibility: c.Visibility, Topic: c.Topic, CategoryID: category,
		SlowModeSeconds: c.SlowModeSeconds, ForumTags: c.ForumTags, Moderation: c.Moderation,
	})
	if err != nil {
		h.unavailable(w, r, "set channel category", err)
		return
	}
	// Categories organize the sidebar of the whole workspace: its clients reload.
	h.categoriesChanged(r.Context(), c.WorkspaceID)
	httpx.WriteJSON(w, http.StatusOK, toAPI(c, role))
}

// --- editing and deleting messages ------------------------------------------

// MessageRef is the data of message.deleted.
type MessageRef struct {
	ID        string `json:"id"`
	ChannelID string `json:"channel_id"`
	// RootID is the thread of a reply.
	RootID string `json:"root_id,omitempty"`
}

// message loads a message of a channel the user belongs to.
func (h *Handlers) message(w http.ResponseWriter, r *http.Request, channelID, messageID openapi_types.UUID, user store.User) (store.Channel, access, store.GetMessageRow, bool) {
	c, role, ok := h.memberChannel(w, r, channelID, user)
	if !ok {
		return c, role, store.GetMessageRow{}, false
	}
	m, err := h.Queries.GetMessage(r.Context(), store.GetMessageParams{ID: pgUUID(messageID), ChannelID: c.ID})
	if isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound,
			Detail: "No message with this id in this channel."})
		return c, role, m, false
	}
	if err != nil {
		h.unavailable(w, r, "get message", err)
		return c, role, m, false
	}
	return c, role, m, true
}

// canRemove: a message's author, or a manager of its channel.
func canRemove(c store.Channel, m store.GetMessageRow, a access, user store.User) bool {
	return m.AuthorID == user.ID || canManage(c, a)
}

// EditMessage implements api.ServerInterface.
func (h *Handlers) EditMessage(w http.ResponseWriter, r *http.Request, channelID, messageID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	if !h.allowAction(w, r, p.User) {
		return
	}
	var in struct {
		Body string `json:"body"`
	}
	if !decode(w, r, &in) {
		return
	}
	body, problem := strings.TrimSpace(in.Body), ""
	if !looksSealed(body) {
		body, problem = validBody(in.Body)
	}
	if problem != "" {
		badRequest(w, r, problem)
		return
	}
	c, role, m, ok := h.message(w, r, channelID, messageID, p.User)
	if !ok {
		return
	}
	if !encryptedBody(c, body) || body == "" {
		refuseEncrypted(w, r)
		return
	}
	if c.Mls && !h.mlsEpochOK(w, r, c, body) {
		return
	}
	switch {
	case m.DeletedAt.Valid:
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound,
			Detail: "The message was deleted."})
		return
	case m.AuthorID != p.User.ID:
		forbidden(w, r, httpx.CodeForbidden, "Only the author can edit a message.")
		return
	case m.BurnSeconds.Valid:
		forbidden(w, r, CodeNotForBurn, "Burn-on-read messages cannot be edited.")
		return
	case c.ArchivedAt.Valid:
		forbidden(w, r, CodeChannelArchived, "The channel is archived.")
		return
	}
	// An edit is held to what sending is: no way around a timeout, the
	// mention rules or AutoMod by sending something harmless first.
	if h.timedOut(w, r, c.WorkspaceID, p.User) {
		return
	}
	noGroups, ok := h.mentionRights(w, r, c, role, body)
	if !ok {
		return
	}
	var flags []string
	if !c.Encrypted {
		if flags, ok = h.automod(w, r, c, role, body); !ok {
			return
		}
	}
	var out api.Message
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		// The text it replaces is kept (when it changes).
		if body != m.Body {
			written := m.CreatedAt
			if m.EditedAt.Valid {
				written = m.EditedAt.Time
			}
			if err := q.AddMessageEdit(r.Context(), store.AddMessageEditParams{
				MessageID: m.ID, Body: m.Body, WrittenAt: written,
			}); err != nil {
				return err
			}
		}
		edited, err := q.EditMessage(r.Context(), store.EditMessageParams{ID: m.ID, Body: body})
		if err != nil {
			return err
		}
		// Mentions follow the new text.
		if err := q.DeleteMentions(r.Context(), m.ID); err != nil {
			return err
		}
		if ids := mentionedIDs(body); len(ids) > 0 {
			if err := q.AddMentions(r.Context(), store.AddMentionsParams{MessageID: m.ID, ChannelID: c.ID, UserIds: ids}); err != nil {
				return err
			}
		}
		if err := addBroadcastMentions(r.Context(), q, h.Presence, c, edited); err != nil {
			return err
		}
		if !noGroups {
			if err := addGroupMentions(r.Context(), q, c, edited); err != nil {
				return err
			}
		}
		if err := flagMessage(r.Context(), q, c, uuid(m.ID), flags); err != nil {
			return err
		}
		msgs := []api.Message{messageAPI(edited, m.AuthorName, m.AuthorIsBot)}
		if err := decorate(r.Context(), q, p.User.ID, msgs); err != nil {
			return err
		}
		out = msgs[0]
		return emit(r.Context(), q, events.MessageUpdated, out)
	})
	if err != nil {
		h.unavailable(w, r, "edit message", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// ListMessageEdits implements api.ServerInterface.
func (h *Handlers) ListMessageEdits(w http.ResponseWriter, r *http.Request, channelID, messageID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	c, _, m, ok := h.message(w, r, channelID, messageID, p.User)
	if !ok {
		return
	}
	if m.DeletedAt.Valid || m.BurnSeconds.Valid {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound,
			Detail: "No such message."})
		return
	}
	if m.AuthorID != p.User.ID {
		ws, err := h.Queries.GetWorkspace(r.Context(), c.WorkspaceID)
		if err != nil {
			h.unavailable(w, r, "get workspace", err)
			return
		}
		if ws.EditHistory != "everyone" {
			forbidden(w, r, httpx.CodeForbidden, "Only its author sees the earlier versions of a message here.")
			return
		}
	}
	rows, err := h.Queries.ListMessageEdits(r.Context(), m.ID)
	if err != nil {
		h.unavailable(w, r, "list edits", err)
		return
	}
	out := make([]api.MessageEdit, 0, len(rows))
	for _, e := range rows {
		out = append(out, api.MessageEdit{Body: e.Body, WrittenAt: e.WrittenAt, ReplacedAt: e.ReplacedAt})
	}
	httpx.WriteJSON(w, http.StatusOK, struct {
		Edits []api.MessageEdit `json:"edits"`
	}{out})
}

// DeleteMessage implements api.ServerInterface.
func (h *Handlers) DeleteMessage(w http.ResponseWriter, r *http.Request, channelID, messageID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	c, role, m, ok := h.message(w, r, channelID, messageID, p.User)
	if !ok {
		return
	}
	if !canRemove(c, m, role, p.User) {
		forbidden(w, r, httpx.CodeForbidden, "Only the author or a channel manager can delete a message.")
		return
	}
	if !m.DeletedAt.Valid {
		err := h.inTx(r.Context(), func(q *store.Queries) error {
			if _, err := q.DeleteMessage(r.Context(), store.DeleteMessageParams{ID: m.ID, DeletedBy: p.User.ID}); err != nil {
				return err
			}
			// Waiting workflow runs it started do not post its text later.
			if _, err := q.ForgetTriggerMessage(r.Context(), m.ID); err != nil {
				return err
			}
			ref := MessageRef{ID: uuid(m.ID).String(), ChannelID: uuid(c.ID).String()}
			if m.RootID.Valid {
				ref.RootID = uuid(m.RootID).String()
			}
			if err := emit(r.Context(), q, events.MessageDeleted, ref); err != nil {
				return err
			}
			if m.RootID.Valid {
				return threadUpdated(r.Context(), q, c.ID, m.RootID)
			}
			return nil
		})
		if err != nil && !isNoRows(err) {
			h.unavailable(w, r, "delete message", err)
			return
		}
		if m.AuthorID != p.User.ID { // moderation
			h.record(r, c.WorkspaceID, audit.MessageRemoved, "message", uuid(m.ID).String(),
				map[string]any{"channel": c.Name, "author": m.AuthorName})
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// RestoreMessage implements api.ServerInterface.
func (h *Handlers) RestoreMessage(w http.ResponseWriter, r *http.Request, channelID, messageID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	c, role, m, ok := h.message(w, r, channelID, messageID, p.User)
	if !ok {
		return
	}
	if !canRemove(c, m, role, p.User) {
		forbidden(w, r, httpx.CodeForbidden, "Only the author or a channel manager can restore a message.")
		return
	}
	// What a manager removed, only a manager brings back.
	if m.DeletedBy.Valid && m.DeletedBy != m.AuthorID && !canManage(c, role) {
		forbidden(w, r, httpx.CodeForbidden, "A channel manager removed this message.")
		return
	}
	var out api.Message
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		restored, err := q.RestoreMessage(r.Context(), store.RestoreMessageParams{ID: m.ID, RestoreWindow: interval(RestoreWindow)})
		if err != nil {
			return err
		}
		msgs := []api.Message{messageAPI(restored, m.AuthorName, m.AuthorIsBot)}
		if err := decorate(r.Context(), q, p.User.ID, msgs); err != nil {
			return err
		}
		out = msgs[0]
		// Members get a burn-on-read message without its text, as when it was sent.
		event := out
		if event.Burn != nil {
			hideBurn(&event)
		}
		if err := emit(r.Context(), q, events.MessageCreated, event); err != nil {
			return err
		}
		if restored.RootID.Valid {
			return threadUpdated(r.Context(), q, c.ID, restored.RootID)
		}
		return nil
	})
	if isNoRows(err) {
		if !m.DeletedAt.Valid { // not deleted: nothing to do
			httpx.WriteJSON(w, http.StatusOK, messageAPI(storeMessage(m), m.AuthorName, m.AuthorIsBot))
			return
		}
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound,
			Detail: "The message can no longer be restored."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "restore message", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

func storeMessage(m store.GetMessageRow) store.Message {
	return store.Message{ID: m.ID, ChannelID: m.ChannelID, AuthorID: m.AuthorID, Body: m.Body, Nonce: m.Nonce,
		CreatedAt: m.CreatedAt, EditedAt: m.EditedAt, Attachments: m.Attachments,
		RootID: m.RootID, AlsoInChannel: m.AlsoInChannel, PinnedAt: m.PinnedAt, PinnedBy: m.PinnedBy,
		Title: m.Title, Tags: m.Tags,
		LinkUrl: m.LinkUrl, LinkState: m.LinkState, Forward: m.Forward, StickerID: m.StickerID, BurnSeconds: m.BurnSeconds,
		TaskID: m.TaskID, SubmissionID: m.SubmissionID,
		Priority: m.Priority, AckRequested: m.AckRequested, Persistent: m.Persistent}
}

// Purger removes deleted messages once they can no longer be restored (a
// periodic job).
type Purger struct{ Queries store.Querier }

// PurgeDeleted implements jobs.Purger.
func (p Purger) PurgeDeleted(ctx context.Context) (int64, error) {
	// Expired dialogs go too.
	if _, err := p.Queries.PurgeDialogs(ctx); err != nil {
		return 0, err
	}
	return p.Queries.PurgeDeletedMessages(ctx, interval(RestoreWindow))
}

func interval(d time.Duration) pgtype.Interval {
	return pgtype.Interval{Microseconds: d.Microseconds(), Valid: true}
}

// SPDX-License-Identifier: Apache-2.0

package chat

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/auth"
	"github.com/barisshn35/cenacle/server/internal/events"
	"github.com/barisshn35/cenacle/server/internal/httpx"
	"github.com/barisshn35/cenacle/server/internal/store"
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
	if !canManage(role, p.User) {
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
	h.publish(r.Context(), events.ChannelUpdated, ChannelEvent{
		Channel: toAPI(c, RoleMember, store.User{}), ChannelID: uuid(c.ID).String(),
	})
	httpx.WriteJSON(w, http.StatusOK, toAPI(c, role, p.User))
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

// requireAdmin answers 403 unless the user is the administrator.
func requireAdmin(w http.ResponseWriter, r *http.Request, user store.User) bool {
	if !user.IsAdmin {
		forbidden(w, r, httpx.CodeForbidden, "Only the administrator can organize categories.")
	}
	return user.IsAdmin
}

func (h *Handlers) categoriesChanged(ctx context.Context) {
	h.publish(ctx, events.CategoriesChanged, struct{}{})
}

// ListCategories implements api.ServerInterface.
func (h *Handlers) ListCategories(w http.ResponseWriter, r *http.Request) {
	if _, ok := auth.RequirePrincipal(w, r, h.Cookies); !ok {
		return
	}
	rows, err := h.Queries.ListCategories(r.Context())
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
	if !ok || !requireAdmin(w, r, p.User) {
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
		badRequest(w, r, strings.Replace(problem, "channel", "category", 1))
		return
	}
	c, err := h.Queries.CreateCategory(r.Context(), name)
	if isUniqueViolation(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeNameTaken,
			Detail: "A category with this name exists."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "create category", err)
		return
	}
	h.categoriesChanged(r.Context())
	httpx.WriteJSON(w, http.StatusCreated, categoryAPI(c))
}

// UpdateCategory implements api.ServerInterface.
func (h *Handlers) UpdateCategory(w http.ResponseWriter, r *http.Request, categoryID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !requireAdmin(w, r, p.User) {
		return
	}
	var in struct {
		Name     *string `json:"name"`
		Position *int    `json:"position"`
	}
	if !decode(w, r, &in) {
		return
	}
	c, err := h.Queries.GetCategory(r.Context(), pgUUID(categoryID))
	if isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound,
			Detail: "No category with this id."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "get category", err)
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
	c, err = h.Queries.UpdateCategory(r.Context(), store.UpdateCategoryParams{ID: c.ID, Name: name, Position: position})
	if isUniqueViolation(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeNameTaken,
			Detail: "A category with this name exists."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "update category", err)
		return
	}
	h.categoriesChanged(r.Context())
	httpx.WriteJSON(w, http.StatusOK, categoryAPI(c))
}

// DeleteCategory implements api.ServerInterface.
func (h *Handlers) DeleteCategory(w http.ResponseWriter, r *http.Request, categoryID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !requireAdmin(w, r, p.User) {
		return
	}
	n, err := h.Queries.DeleteCategory(r.Context(), pgUUID(categoryID))
	if err != nil {
		h.unavailable(w, r, "delete category", err)
		return
	}
	if n == 0 {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound,
			Detail: "No category with this id."})
		return
	}
	h.categoriesChanged(r.Context())
	w.WriteHeader(http.StatusNoContent)
}

// SetChannelCategory implements api.ServerInterface.
func (h *Handlers) SetChannelCategory(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !requireAdmin(w, r, p.User) {
		return
	}
	var in struct {
		CategoryID *openapi_types.UUID `json:"category_id"`
	}
	if !decode(w, r, &in) {
		return
	}
	c, role, ok := h.visibleChannel(w, r, channelID, p.User)
	if !ok {
		return
	}
	category := c.CategoryID
	category.Valid = in.CategoryID != nil
	if in.CategoryID != nil {
		if _, err := h.Queries.GetCategory(r.Context(), pgUUID(*in.CategoryID)); isNoRows(err) {
			badRequest(w, r, "No category with this id.")
			return
		} else if err != nil {
			h.unavailable(w, r, "get category", err)
			return
		}
		category = pgUUID(*in.CategoryID)
	}
	c, err := h.Queries.UpdateChannel(r.Context(), store.UpdateChannelParams{
		ID: c.ID, Name: c.Name, Visibility: c.Visibility, Topic: c.Topic, CategoryID: category,
	})
	if err != nil {
		h.unavailable(w, r, "set channel category", err)
		return
	}
	// Categories organize everyone's sidebar: all clients reload.
	h.categoriesChanged(r.Context())
	httpx.WriteJSON(w, http.StatusOK, toAPI(c, role, p.User))
}

// --- editing and deleting messages ------------------------------------------

// MessageRef is the data of message.deleted.
type MessageRef struct {
	ID        string `json:"id"`
	ChannelID string `json:"channel_id"`
}

// message loads a message of a channel the user belongs to.
func (h *Handlers) message(w http.ResponseWriter, r *http.Request, channelID, messageID openapi_types.UUID, user store.User) (store.Channel, string, store.GetMessageRow, bool) {
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
func canRemove(m store.GetMessageRow, role string, user store.User) bool {
	return m.AuthorID == user.ID || canManage(role, user)
}

// EditMessage implements api.ServerInterface.
func (h *Handlers) EditMessage(w http.ResponseWriter, r *http.Request, channelID, messageID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in struct {
		Body string `json:"body"`
	}
	if !decode(w, r, &in) {
		return
	}
	body, problem := validBody(in.Body)
	if problem != "" {
		badRequest(w, r, problem)
		return
	}
	c, _, m, ok := h.message(w, r, channelID, messageID, p.User)
	if !ok {
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
	case c.ArchivedAt.Valid:
		forbidden(w, r, CodeChannelArchived, "The channel is archived.")
		return
	}
	edited, err := h.Queries.EditMessage(r.Context(), store.EditMessageParams{ID: m.ID, Body: body})
	if err != nil {
		h.unavailable(w, r, "edit message", err)
		return
	}
	out := messageAPI(edited, m.AuthorName)
	h.publish(r.Context(), events.MessageUpdated, out)
	httpx.WriteJSON(w, http.StatusOK, out)
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
	if !canRemove(m, role, p.User) {
		forbidden(w, r, httpx.CodeForbidden, "Only the author or a channel manager can delete a message.")
		return
	}
	if !m.DeletedAt.Valid {
		if _, err := h.Queries.DeleteMessage(r.Context(), store.DeleteMessageParams{ID: m.ID, DeletedBy: p.User.ID}); err != nil && !isNoRows(err) {
			h.unavailable(w, r, "delete message", err)
			return
		}
		h.publish(r.Context(), events.MessageDeleted, MessageRef{ID: uuid(m.ID).String(), ChannelID: uuid(c.ID).String()})
	}
	w.WriteHeader(http.StatusNoContent)
}

// RestoreMessage implements api.ServerInterface.
func (h *Handlers) RestoreMessage(w http.ResponseWriter, r *http.Request, channelID, messageID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	_, role, m, ok := h.message(w, r, channelID, messageID, p.User)
	if !ok {
		return
	}
	if !canRemove(m, role, p.User) {
		forbidden(w, r, httpx.CodeForbidden, "Only the author or a channel manager can restore a message.")
		return
	}
	restored, err := h.Queries.RestoreMessage(r.Context(), store.RestoreMessageParams{ID: m.ID, RestoreWindow: interval(RestoreWindow)})
	if isNoRows(err) {
		if !m.DeletedAt.Valid { // not deleted: nothing to do
			httpx.WriteJSON(w, http.StatusOK, messageAPI(storeMessage(m), m.AuthorName))
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
	out := messageAPI(restored, m.AuthorName)
	h.publish(r.Context(), events.MessageCreated, out)
	httpx.WriteJSON(w, http.StatusOK, out)
}

func storeMessage(m store.GetMessageRow) store.Message {
	return store.Message{ID: m.ID, ChannelID: m.ChannelID, AuthorID: m.AuthorID, Body: m.Body, Nonce: m.Nonce,
		CreatedAt: m.CreatedAt, EditedAt: m.EditedAt}
}

// RunPurge removes deleted messages once they can no longer be restored.
func RunPurge(ctx context.Context, q store.Querier, every time.Duration, log *slog.Logger) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if n, err := q.PurgeDeletedMessages(ctx, interval(RestoreWindow)); err != nil {
				log.Warn("purging deleted messages failed", "error", err)
			} else if n > 0 {
				log.Info("deleted messages purged", "count", n)
			}
		}
	}
}

func interval(d time.Duration) pgtype.Interval {
	return pgtype.Interval{Microseconds: d.Microseconds(), Valid: true}
}

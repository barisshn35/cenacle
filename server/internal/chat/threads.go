// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"context"
	"encoding/json"
	"fmt"
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

// Limits of pins and saved messages.
const (
	MaxPinsPerChannel = 50
	MaxSavedMessages  = 500
	CodePinLimit      = "pin_limit"
	CodeSavedLimit    = "saved_limit"
)

// ThreadEvent is the data of thread.updated: a thread's replies changed
// (Thread is null when none are left).
type ThreadEvent struct {
	ChannelID string             `json:"channel_id"`
	RootID    string             `json:"root_id"`
	Thread    *api.ThreadSummary `json:"thread"`
}

// ThreadFollowEvent is the data of thread.followed and thread.read.
type ThreadFollowEvent struct {
	UserID    string `json:"user_id"`
	RootID    string `json:"root_id"`
	Following *bool  `json:"following,omitempty"`
	MessageID string `json:"message_id,omitempty"`
}

// SavedEvent is the data of saved.changed (Item is null when removed).
type SavedEvent struct {
	UserID    string         `json:"user_id"`
	MessageID string         `json:"message_id"`
	Item      *api.SavedItem `json:"item"`
}

func threadAPI(s store.ThreadSummariesRow) *api.ThreadSummary {
	t := &api.ThreadSummary{ReplyCount: int(s.ReplyCount), LastReplyAt: s.LastReplyAt, Participants: []api.Author{}}
	_ = json.Unmarshal(s.Participants, &t.Participants)
	return t
}

// threadUpdated tells a channel's members how a thread's replies look now.
func threadUpdated(ctx context.Context, q *store.Queries, channel, root pgtype.UUID) error {
	ev := ThreadEvent{ChannelID: uuid(channel).String(), RootID: uuid(root).String()}
	rows, err := q.ThreadSummaries(ctx, []pgtype.UUID{root})
	if err != nil {
		return err
	}
	if len(rows) > 0 {
		ev.Thread = threadAPI(rows[0])
	}
	return emit(ctx, q, events.ThreadUpdated, ev)
}

// threadRoot loads the message a reply answers, in the channel: a reply's
// own root when it is a reply.
func (h *Handlers) threadRoot(w http.ResponseWriter, r *http.Request, c store.Channel, id openapi_types.UUID) (store.GetMessageRow, bool) {
	root, err := h.Queries.GetMessage(r.Context(), store.GetMessageParams{ID: pgUUID(id), ChannelID: c.ID})
	if err == nil && root.RootID.Valid {
		root, err = h.Queries.GetMessage(r.Context(), store.GetMessageParams{ID: root.RootID, ChannelID: c.ID})
	}
	if isNoRows(err) || (err == nil && root.DeletedAt.Valid) {
		badRequest(w, r, "The message to reply to is not in this channel or was deleted.")
		return root, false
	}
	// A burn-on-read message is read once: it has no thread to show it again in.
	if err == nil && root.BurnSeconds.Valid {
		badRequest(w, r, "Burn-on-read messages cannot be replied to.")
		return root, false
	}
	if err != nil {
		h.unavailable(w, r, "get thread root", err)
		return root, false
	}
	return root, true
}

// GetMessage implements api.ServerInterface.
func (h *Handlers) GetMessage(w http.ResponseWriter, r *http.Request, channelID, messageID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	_, _, m, ok := h.message(w, r, channelID, messageID, p.User)
	if !ok {
		return
	}
	if m.DeletedAt.Valid {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound,
			Detail: "The message was deleted."})
		return
	}
	msgs := []api.Message{messageAPI(storeMessage(m), m.AuthorName, m.AuthorIsBot)}
	if err := decorate(r.Context(), h.Queries, p.User.ID, msgs); err != nil {
		h.unavailable(w, r, "decorate message", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, msgs[0])
}

// ListReplies implements api.ServerInterface.
func (h *Handlers) ListReplies(w http.ResponseWriter, r *http.Request, channelID, messageID openapi_types.UUID, params api.ListRepliesParams) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	if _, _, _, ok = h.message(w, r, channelID, messageID, p.User); !ok {
		return
	}
	limit := defaultPage
	if params.Limit != nil {
		limit = *params.Limit
	}
	if limit < 1 || limit > 100 {
		badRequest(w, r, "limit must be between 1 and 100.")
		return
	}
	var before pgtype.UUID
	if params.Before != nil {
		before = pgUUID(*params.Before)
	}
	rows, err := h.Queries.ListReplies(r.Context(), store.ListRepliesParams{
		RootID: pgUUID(messageID), Before: before, RowLimit: int32(limit + 1),
	})
	if err != nil {
		h.unavailable(w, r, "list replies", err)
		return
	}
	hasMore := len(rows) > limit
	if hasMore {
		rows = rows[:limit]
	}
	page := api.MessagePage{HasMore: hasMore, Messages: make([]api.Message, len(rows))}
	for i, m := range rows {
		page.Messages[len(rows)-1-i] = messageAPI(store.Message{
			ID: m.ID, ChannelID: m.ChannelID, AuthorID: m.AuthorID, Body: m.Body, Nonce: m.Nonce,
			CreatedAt: m.CreatedAt, EditedAt: m.EditedAt, Attachments: m.Attachments,
			RootID: m.RootID, AlsoInChannel: m.AlsoInChannel, PinnedAt: m.PinnedAt, PinnedBy: m.PinnedBy,
			Title: m.Title, Tags: m.Tags,
			LinkUrl: m.LinkUrl, LinkState: m.LinkState, Forward: m.Forward, StickerID: m.StickerID, BurnSeconds: m.BurnSeconds,
			TaskID: m.TaskID, SubmissionID: m.SubmissionID,
			Priority: m.Priority, AckRequested: m.AckRequested, Persistent: m.Persistent,
		}, m.AuthorName, m.AuthorIsBot)
	}
	if err := decorate(r.Context(), h.Queries, p.User.ID, page.Messages); err != nil {
		h.unavailable(w, r, "decorate replies", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, page)
}

// --- following threads ------------------------------------------------------

// rootFor loads a thread's first message for the user (a member of its
// channel).
func (h *Handlers) rootFor(w http.ResponseWriter, r *http.Request, id openapi_types.UUID, user store.User) (store.GetMessagesByIDsRow, bool) {
	m, ok := h.messageAnywhere(w, r, id, user)
	if ok && m.RootID.Valid {
		badRequest(w, r, "This message is a reply; use its thread's first message.")
		return m, false
	}
	return m, ok
}

// messageAnywhere loads a message by id for a member of its channel.
func (h *Handlers) messageAnywhere(w http.ResponseWriter, r *http.Request, id openapi_types.UUID, user store.User) (store.GetMessagesByIDsRow, bool) {
	rows, err := h.Queries.GetMessagesByIDs(r.Context(), []pgtype.UUID{pgUUID(id)})
	if err != nil {
		h.unavailable(w, r, "get message", err)
		return store.GetMessagesByIDsRow{}, false
	}
	if len(rows) == 0 || rows[0].DeletedAt.Valid {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound,
			Detail: "No such message."})
		return store.GetMessagesByIDsRow{}, false
	}
	role, err := h.Queries.GetMemberRole(r.Context(), store.GetMemberRoleParams{ChannelID: rows[0].ChannelID, UserID: user.ID})
	if err != nil {
		h.unavailable(w, r, "get membership", err)
		return rows[0], false
	}
	if role == "" {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound,
			Detail: "No such message."})
		return rows[0], false
	}
	return rows[0], true
}

// GetThreadFollowing implements api.ServerInterface.
func (h *Handlers) GetThreadFollowing(w http.ResponseWriter, r *http.Request, rootID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	root, ok := h.rootFor(w, r, rootID, p.User)
	if !ok {
		return
	}
	f, err := h.Queries.GetThreadFollow(r.Context(), store.GetThreadFollowParams{UserID: p.User.ID, RootID: root.ID})
	if err != nil && !isNoRows(err) {
		h.unavailable(w, r, "get thread follow", err)
		return
	}
	out := struct {
		Following  bool                `json:"following"`
		LastReadID *openapi_types.UUID `json:"last_read_id"`
	}{Following: f.Following}
	if f.LastReadID.Valid {
		id := uuid(f.LastReadID)
		out.LastReadID = &id
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// SetThreadFollowing implements api.ServerInterface.
func (h *Handlers) SetThreadFollowing(w http.ResponseWriter, r *http.Request, rootID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.SetThreadFollowingJSONBody
	if !decode(w, r, &in) {
		return
	}
	root, ok := h.rootFor(w, r, rootID, p.User)
	if !ok {
		return
	}
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		if err := q.SetThreadFollowing(r.Context(), store.SetThreadFollowingParams{
			UserID: p.User.ID, RootID: root.ID, Following: in.Following,
		}); err != nil {
			return err
		}
		return emit(r.Context(), q, events.ThreadFollowed, ThreadFollowEvent{
			UserID: uuid(p.User.ID).String(), RootID: uuid(root.ID).String(), Following: &in.Following,
		})
	})
	if err != nil {
		h.unavailable(w, r, "follow thread", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// MarkThreadRead implements api.ServerInterface.
func (h *Handlers) MarkThreadRead(w http.ResponseWriter, r *http.Request, rootID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.MarkThreadReadJSONBody
	if !decode(w, r, &in) {
		return
	}
	root, ok := h.rootFor(w, r, rootID, p.User)
	if !ok {
		return
	}
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		n, err := q.MarkThreadRead(r.Context(), store.MarkThreadReadParams{
			UserID: p.User.ID, RootID: root.ID, MessageID: pgUUID(in.MessageId),
		})
		if err != nil || n == 0 {
			return err
		}
		return emit(r.Context(), q, events.ThreadRead, ThreadFollowEvent{
			UserID: uuid(p.User.ID).String(), RootID: uuid(root.ID).String(), MessageID: in.MessageId.String(),
		})
	})
	if err != nil {
		h.unavailable(w, r, "mark thread read", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ListThreads implements api.ServerInterface.
func (h *Handlers) ListThreads(w http.ResponseWriter, r *http.Request, params api.ListThreadsParams) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	limit := 20
	if params.Limit != nil {
		limit = *params.Limit
	}
	if limit < 1 || limit > 50 {
		badRequest(w, r, "limit must be between 1 and 50.")
		return
	}
	arg := store.ListFollowedThreadsParams{UserID: p.User.ID, RowLimit: int32(limit + 1)}
	if params.WorkspaceId != nil {
		arg.WorkspaceID = pgUUID(*params.WorkspaceId)
	}
	if params.Before != nil {
		arg.Before = pgUUID(*params.Before)
	}
	rows, err := h.Queries.ListFollowedThreads(r.Context(), arg)
	if err != nil {
		h.unavailable(w, r, "list threads", err)
		return
	}
	hasMore := len(rows) > limit
	if hasMore {
		rows = rows[:limit]
	}
	roots := make([]api.Message, len(rows))
	for i, t := range rows {
		roots[i] = messageAPI(store.Message{
			ID: t.ID, ChannelID: t.ChannelID, AuthorID: t.AuthorID, Body: t.Body, Nonce: t.Nonce,
			CreatedAt: t.CreatedAt, EditedAt: t.EditedAt, Attachments: t.Attachments,
			PinnedAt: t.PinnedAt, PinnedBy: t.PinnedBy, Title: t.Title, Tags: t.Tags,
			BurnSeconds: t.BurnSeconds,
		}, t.AuthorName, t.AuthorIsBot)
	}
	if err := decorate(r.Context(), h.Queries, p.User.ID, roots); err != nil {
		h.unavailable(w, r, "decorate threads", err)
		return
	}
	out := struct {
		Threads []api.FollowedThread `json:"threads"`
		HasMore bool                 `json:"has_more"`
	}{Threads: make([]api.FollowedThread, len(rows)), HasMore: hasMore}
	for i, t := range rows {
		out.Threads[i] = api.FollowedThread{
			Root: roots[i], Channel: searchChannel(t.ChannelID, t.WorkspaceID, t.ChannelName, t.ChannelKind),
			UnreadCount: int(t.UnreadCount), MentionCount: int(t.MentionCount), LastReplyId: uuid(t.LastReplyID),
		}
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// CountUnreadThreads implements api.ServerInterface.
func (h *Handlers) CountUnreadThreads(w http.ResponseWriter, r *http.Request, params api.CountUnreadThreadsParams) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	arg := store.CountUnreadThreadsParams{UserID: p.User.ID}
	if params.WorkspaceId != nil {
		arg.WorkspaceID = pgUUID(*params.WorkspaceId)
	}
	n, err := h.Queries.CountUnreadThreads(r.Context(), arg)
	if err != nil {
		h.unavailable(w, r, "count threads", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]int{"threads": int(n.Threads), "mentions": int(n.Mentioned)})
}

// --- pins -------------------------------------------------------------------

func (h *Handlers) setPinned(w http.ResponseWriter, r *http.Request, channelID, messageID openapi_types.UUID, pinned bool) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	if !h.allowAction(w, r, p.User) {
		return
	}
	c, role, m, ok := h.message(w, r, channelID, messageID, p.User)
	if !ok {
		return
	}
	switch {
	case m.DeletedAt.Valid:
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound,
			Detail: "The message was deleted."})
		return
	case m.BurnSeconds.Valid:
		forbidden(w, r, CodeNotForBurn, "Burn-on-read messages cannot be pinned.")
		return
	case !canPost(c, role):
		forbidden(w, r, httpx.CodeForbidden, "Only people who can post here pin messages.")
		return
	}
	if m.PinnedAt.Valid == pinned {
		httpx.WriteJSON(w, http.StatusOK, messageAPI(storeMessage(m), m.AuthorName, m.AuthorIsBot))
		return
	}
	if pinned {
		n, err := h.Queries.CountPins(r.Context(), c.ID)
		if err != nil {
			h.unavailable(w, r, "count pins", err)
			return
		}
		if n >= MaxPinsPerChannel {
			httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodePinLimit,
				Detail: "A channel has up to 50 pinned messages; unpin one first."})
			return
		}
	}
	var out api.Message
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		updated, err := q.SetPinned(r.Context(), store.SetPinnedParams{ID: m.ID, Pinned: pinned, PinnedBy: p.User.ID})
		if err != nil {
			return err
		}
		msgs := []api.Message{messageAPI(updated, m.AuthorName, m.AuthorIsBot)}
		if err := decorate(r.Context(), q, p.User.ID, msgs); err != nil {
			return err
		}
		out = msgs[0]
		return emit(r.Context(), q, events.MessageUpdated, out)
	})
	if err != nil {
		h.unavailable(w, r, "pin message", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// PinMessage implements api.ServerInterface.
func (h *Handlers) PinMessage(w http.ResponseWriter, r *http.Request, channelID, messageID openapi_types.UUID) {
	h.setPinned(w, r, channelID, messageID, true)
}

// UnpinMessage implements api.ServerInterface.
func (h *Handlers) UnpinMessage(w http.ResponseWriter, r *http.Request, channelID, messageID openapi_types.UUID) {
	h.setPinned(w, r, channelID, messageID, false)
}

// ListPins implements api.ServerInterface.
func (h *Handlers) ListPins(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	c, _, ok := h.memberChannel(w, r, channelID, p.User)
	if !ok {
		return
	}
	rows, err := h.Queries.ListPins(r.Context(), c.ID)
	if err != nil {
		h.unavailable(w, r, "list pins", err)
		return
	}
	msgs := make([]api.Message, len(rows))
	for i, m := range rows {
		msgs[i] = messageAPI(store.Message{
			ID: m.ID, ChannelID: m.ChannelID, AuthorID: m.AuthorID, Body: m.Body, Nonce: m.Nonce,
			CreatedAt: m.CreatedAt, EditedAt: m.EditedAt, Attachments: m.Attachments,
			RootID: m.RootID, AlsoInChannel: m.AlsoInChannel, PinnedAt: m.PinnedAt, PinnedBy: m.PinnedBy,
			Title: m.Title, Tags: m.Tags,
			LinkUrl: m.LinkUrl, LinkState: m.LinkState, Forward: m.Forward, StickerID: m.StickerID, BurnSeconds: m.BurnSeconds,
			TaskID: m.TaskID, SubmissionID: m.SubmissionID,
			Priority: m.Priority, AckRequested: m.AckRequested, Persistent: m.Persistent,
		}, m.AuthorName, m.AuthorIsBot)
	}
	if err := decorate(r.Context(), h.Queries, p.User.ID, msgs); err != nil {
		h.unavailable(w, r, "decorate pins", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string][]api.Message{"messages": msgs})
}

// --- saved messages -----------------------------------------------------------

func messageOf(m store.GetMessagesByIDsRow) api.Message {
	return messageAPI(store.Message{
		ID: m.ID, ChannelID: m.ChannelID, AuthorID: m.AuthorID, Body: m.Body, Nonce: m.Nonce,
		CreatedAt: m.CreatedAt, EditedAt: m.EditedAt, Attachments: m.Attachments,
		RootID: m.RootID, AlsoInChannel: m.AlsoInChannel, PinnedAt: m.PinnedAt, PinnedBy: m.PinnedBy,
		Title: m.Title, Tags: m.Tags,
		LinkUrl: m.LinkUrl, LinkState: m.LinkState, Forward: m.Forward, StickerID: m.StickerID, BurnSeconds: m.BurnSeconds,
		TaskID: m.TaskID, SubmissionID: m.SubmissionID,
		Priority: m.Priority, AckRequested: m.AckRequested, Persistent: m.Persistent,
	}, m.AuthorName, m.AuthorIsBot)
}

// messagesByID loads and decorates messages for a reader, by id.
func (h *Handlers) messagesByID(ctx context.Context, reader pgtype.UUID, ids []pgtype.UUID) (map[openapi_types.UUID]store.GetMessagesByIDsRow, map[openapi_types.UUID]api.Message, error) {
	rows, err := h.Queries.GetMessagesByIDs(ctx, ids)
	if err != nil {
		return nil, nil, err
	}
	msgs := make([]api.Message, len(rows))
	for i, m := range rows {
		msgs[i] = messageOf(m)
	}
	if err := decorate(ctx, h.Queries, reader, msgs); err != nil {
		return nil, nil, err
	}
	byRow := make(map[openapi_types.UUID]store.GetMessagesByIDsRow, len(rows))
	byMsg := make(map[openapi_types.UUID]api.Message, len(rows))
	for i, m := range rows {
		byRow[uuid(m.ID)] = m
		byMsg[uuid(m.ID)] = msgs[i]
	}
	return byRow, byMsg, nil
}

func savedAPI(row store.GetMessagesByIDsRow, msg api.Message, savedAt time.Time, remindAt, doneAt pgtype.Timestamptz) api.SavedItem {
	return api.SavedItem{
		Message: msg, Channel: searchChannel(row.ChannelID, row.WorkspaceID, row.ChannelName, row.ChannelKind),
		SavedAt: savedAt, RemindAt: timePtr(remindAt), DoneAt: timePtr(doneAt),
	}
}

// ListSaved implements api.ServerInterface.
func (h *Handlers) ListSaved(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	rows, err := h.Queries.ListSaved(r.Context(), p.User.ID)
	if err != nil {
		h.unavailable(w, r, "list saved", err)
		return
	}
	ids := make([]pgtype.UUID, len(rows))
	for i, s := range rows {
		ids[i] = s.MessageID
	}
	byRow, byMsg, err := h.messagesByID(r.Context(), p.User.ID, ids)
	if err != nil {
		h.unavailable(w, r, "load saved", err)
		return
	}
	items := make([]api.SavedItem, 0, len(rows))
	for _, s := range rows {
		id := uuid(s.MessageID)
		items = append(items, savedAPI(byRow[id], byMsg[id], s.SavedAt, s.RemindAt, s.DoneAt))
	}
	httpx.WriteJSON(w, http.StatusOK, map[string][]api.SavedItem{"items": items})
}

// SaveMessage implements api.ServerInterface.
func (h *Handlers) SaveMessage(w http.ResponseWriter, r *http.Request, messageID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.SaveMessageJSONBody
	if !decode(w, r, &in) {
		return
	}
	done := in.Done != nil && *in.Done
	var remindAt pgtype.Timestamptz
	if in.RemindAt != nil && !done {
		if in.RemindAt.Before(time.Now().Add(-time.Minute)) || time.Until(*in.RemindAt) > MaxReminderAhead {
			badRequest(w, r, "remind_at must be in the coming year.")
			return
		}
		remindAt = pgtype.Timestamptz{Time: *in.RemindAt, Valid: true}
	}
	m, ok := h.messageAnywhere(w, r, messageID, p.User)
	if !ok {
		return
	}
	if m.BurnSeconds.Valid {
		forbidden(w, r, CodeNotForBurn, "Burn-on-read messages cannot be saved.")
		return
	}
	before, err := h.Queries.GetSaved(r.Context(), store.GetSavedParams{UserID: p.User.ID, MessageID: m.ID})
	if isNoRows(err) {
		n, err := h.Queries.CountSaved(r.Context(), p.User.ID)
		if err != nil {
			h.unavailable(w, r, "count saved", err)
			return
		}
		if n >= MaxSavedMessages {
			httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeSavedLimit,
				Detail: "You can keep up to 500 saved messages; remove some first."})
			return
		}
	} else if err != nil {
		h.unavailable(w, r, "get saved", err)
		return
	}
	var item api.SavedItem
	err = h.inTx(r.Context(), func(q *store.Queries) error {
		saved, err := q.UpsertSaved(r.Context(), store.UpsertSavedParams{
			UserID: p.User.ID, MessageID: m.ID, RemindAt: remindAt, Done: done,
		})
		if err != nil {
			return err
		}
		// A changed reminder replaces the old one.
		if before.RemindAt != saved.RemindAt || !remindAt.Valid {
			if before.ReminderID.Valid {
				if err := q.CancelScheduled(r.Context(), before.ReminderID); err != nil {
					return err
				}
			}
			var reminder pgtype.UUID
			if remindAt.Valid {
				s, err := h.scheduleReminder(r.Context(), q, m.WorkspaceID, p.User, savedReminderText(m), remindAt.Time)
				if err != nil {
					return err
				}
				reminder = s.ID
			}
			if err := q.SetSavedReminder(r.Context(), store.SetSavedReminderParams{
				UserID: p.User.ID, MessageID: m.ID, ReminderID: reminder,
			}); err != nil {
				return err
			}
		}
		msgs := []api.Message{messageOf(m)}
		if err := decorate(r.Context(), q, p.User.ID, msgs); err != nil {
			return err
		}
		item = savedAPI(m, msgs[0], saved.CreatedAt, saved.RemindAt, saved.DoneAt)
		return emit(r.Context(), q, events.SavedChanged, SavedEvent{
			UserID: uuid(p.User.ID).String(), MessageID: messageID.String(), Item: &item,
		})
	})
	if err != nil {
		h.unavailable(w, r, "save message", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, item)
}

// savedReminderText: the reminder points at the saved message.
func savedReminderText(m store.GetMessagesByIDsRow) string {
	excerpt := strings.Join(strings.Fields(m.Body), " ")
	if r := []rune(excerpt); len(r) > 200 {
		excerpt = string(r[:200]) + "…"
	}
	link := fmt.Sprintf("/c/%s?m=%s", uuid(m.ChannelID), uuid(m.ID))
	if excerpt == "" {
		return fmt.Sprintf("⏰ [A message you saved](%s)", link)
	}
	return fmt.Sprintf("⏰ [A message you saved](%s): %s", link, excerpt)
}

// UnsaveMessage implements api.ServerInterface.
func (h *Handlers) UnsaveMessage(w http.ResponseWriter, r *http.Request, messageID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		saved, err := q.DeleteSaved(r.Context(), store.DeleteSavedParams{UserID: p.User.ID, MessageID: pgUUID(messageID)})
		if err != nil {
			return err
		}
		if saved.ReminderID.Valid {
			if err := q.CancelScheduled(r.Context(), saved.ReminderID); err != nil {
				return err
			}
		}
		return emit(r.Context(), q, events.SavedChanged, SavedEvent{
			UserID: uuid(p.User.ID).String(), MessageID: messageID.String(),
		})
	})
	if err != nil && !isNoRows(err) {
		h.unavailable(w, r, "unsave message", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- activity and unread messages --------------------------------------------

// ListActivity implements api.ServerInterface.
func (h *Handlers) ListActivity(w http.ResponseWriter, r *http.Request, params api.ListActivityParams) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	limit := 30
	if params.Limit != nil {
		limit = *params.Limit
	}
	if limit < 1 || limit > 50 {
		badRequest(w, r, "limit must be between 1 and 50.")
		return
	}
	arg := store.ListActivityParams{UserID: p.User.ID, RowLimit: int32(limit + 1)}
	if params.WorkspaceId != nil {
		arg.WorkspaceID = pgUUID(*params.WorkspaceId)
	}
	if params.Before != nil {
		arg.Before = pgtype.Timestamptz{Time: *params.Before, Valid: true}
	}
	rows, err := h.Queries.ListActivity(r.Context(), arg)
	if err != nil {
		h.unavailable(w, r, "list activity", err)
		return
	}
	hasMore := len(rows) > limit
	if hasMore {
		rows = rows[:limit]
	}
	ids := make([]pgtype.UUID, 0, len(rows))
	actors := make([]pgtype.UUID, 0, len(rows))
	for _, a := range rows {
		ids = append(ids, a.MessageID)
		actors = append(actors, a.ActorID)
	}
	byRow, byMsg, err := h.messagesByID(r.Context(), p.User.ID, ids)
	if err != nil {
		h.unavailable(w, r, "load activity", err)
		return
	}
	people, err := h.Queries.GetUsersByIDs(r.Context(), actors)
	if err != nil {
		h.unavailable(w, r, "load people", err)
		return
	}
	names := make(map[pgtype.UUID]store.User, len(people))
	for _, u := range people {
		names[u.ID] = u
	}
	out := struct {
		Items   []api.ActivityItem `json:"items"`
		HasMore bool               `json:"has_more"`
	}{Items: make([]api.ActivityItem, 0, len(rows)), HasMore: hasMore}
	for _, a := range rows {
		id := uuid(a.MessageID)
		m, ok := byRow[id]
		if !ok {
			continue
		}
		actor := api.Author{Id: uuid(a.ActorID), DisplayName: names[a.ActorID].DisplayName}
		if names[a.ActorID].IsBot {
			bot := true
			actor.IsBot = &bot
		}
		out.Items = append(out.Items, api.ActivityItem{
			Kind: api.ActivityItemKind(a.Kind), At: a.At, Actor: actor, Emoji: a.Emoji, Message: byMsg[id],
			Channel: searchChannel(m.ChannelID, m.WorkspaceID, m.ChannelName, m.ChannelKind),
		})
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// ListUnreads implements api.ServerInterface.
func (h *Handlers) ListUnreads(w http.ResponseWriter, r *http.Request, params api.ListUnreadsParams) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	rows, err := h.Queries.ListUnreadMessages(r.Context(), store.ListUnreadMessagesParams{
		UserID: p.User.ID, WorkspaceID: pgUUID(params.WorkspaceId),
	})
	if err != nil {
		h.unavailable(w, r, "list unread", err)
		return
	}
	msgs := make([]api.Message, len(rows))
	for i, m := range rows {
		msgs[i] = messageAPI(store.Message{
			ID: m.ID, ChannelID: m.ChannelID, AuthorID: m.AuthorID, Body: m.Body, Nonce: m.Nonce,
			CreatedAt: m.CreatedAt, EditedAt: m.EditedAt, Attachments: m.Attachments,
			RootID: m.RootID, AlsoInChannel: m.AlsoInChannel, PinnedAt: m.PinnedAt, PinnedBy: m.PinnedBy,
			Title: m.Title, Tags: m.Tags,
			LinkUrl: m.LinkUrl, LinkState: m.LinkState, Forward: m.Forward, StickerID: m.StickerID, BurnSeconds: m.BurnSeconds,
			TaskID: m.TaskID, SubmissionID: m.SubmissionID,
			Priority: m.Priority, AckRequested: m.AckRequested, Persistent: m.Persistent,
		}, m.AuthorName, m.AuthorIsBot)
	}
	if err := decorate(r.Context(), h.Queries, p.User.ID, msgs); err != nil {
		h.unavailable(w, r, "decorate unread", err)
		return
	}
	type group struct {
		ChannelID openapi_types.UUID `json:"channel_id"`
		Messages  []api.Message      `json:"messages"`
	}
	out := struct {
		Channels []group `json:"channels"`
	}{Channels: []group{}}
	for _, m := range msgs {
		if n := len(out.Channels); n == 0 || out.Channels[n-1].ChannelID != m.ChannelId {
			out.Channels = append(out.Channels, group{ChannelID: m.ChannelId})
		}
		last := &out.Channels[len(out.Channels)-1]
		last.Messages = append(last.Messages, m)
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"slices"
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

// MaxConversationPeople is how many others a group conversation can have.
const MaxConversationPeople = 8

// TypingInterval is how often one user's typing notices go out per channel.
const TypingInterval = 2 * time.Second

func hasConversationPrefix(name string) bool {
	n := strings.ToLower(name)
	return strings.HasPrefix(n, KindDirect+":") || strings.HasPrefix(n, KindGroup+":")
}

// conversationKey names a conversation after its people (sorted ids, the
// user included), so the same people always get the same conversation:
// "direct:<a>:<b>" for two, "group:<sha256>" for more.
func conversationKey(ids []string) (kind, key string) {
	ids = slices.Sorted(slices.Values(ids))
	if len(ids) == 2 {
		return KindDirect, KindDirect + ":" + ids[0] + ":" + ids[1]
	}
	sum := sha256.Sum256([]byte(strings.Join(ids, ",")))
	return KindGroup, KindGroup + ":" + hex.EncodeToString(sum[:])
}

// OpenConversation implements api.ServerInterface.
func (h *Handlers) OpenConversation(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in struct {
		UserIDs []openapi_types.UUID `json:"user_ids"`
	}
	if !decode(w, r, &in) {
		return
	}
	wsRole, ok := h.workspaceRole(w, r, workspaceID, p.User)
	if !ok {
		return
	}
	self := uuid(p.User.ID)
	others := []openapi_types.UUID{}
	for _, id := range in.UserIDs {
		if id != self && !slices.Contains(others, id) {
			others = append(others, id)
		}
	}
	if len(others) == 0 || len(others) > MaxConversationPeople {
		badRequest(w, r, "Name 1 to 8 other people.")
		return
	}
	ws := pgUUID(workspaceID)
	visible, ok := h.visiblePeople(w, r, workspaceID, p.User, wsRole)
	if !ok {
		return
	}
	people := make([]api.Person, 0, len(others))
	ids := []string{self.String()}
	for _, id := range others {
		role, err := h.Queries.GetWorkspaceRole(r.Context(), store.GetWorkspaceRoleParams{WorkspaceID: ws, UserID: pgUUID(id)})
		if err != nil {
			h.unavailable(w, r, "get workspace role", err)
			return
		}
		if role == "" || (visible != nil && !visible[pgUUID(id)]) {
			badRequest(w, r, "Everyone must be a member of the workspace.")
			return
		}
		u, err := h.Queries.GetUser(r.Context(), pgUUID(id))
		if err != nil {
			h.unavailable(w, r, "get user", err)
			return
		}
		people = append(people, api.Person{Id: id, DisplayName: u.DisplayName, Email: u.Email})
		ids = append(ids, id.String())
	}
	kind, key := conversationKey(ids)

	status := http.StatusOK
	c, err := h.Queries.GetChannelByName(r.Context(), store.GetChannelByNameParams{WorkspaceID: ws, Name: key})
	if isNoRows(err) {
		status = http.StatusCreated
		c, err = h.Queries.CreateConversation(r.Context(), store.CreateConversationParams{
			WorkspaceID: ws, Name: key, Kind: kind, CreatedBy: p.User.ID,
		})
	}
	if err != nil {
		h.unavailable(w, r, "open conversation", err)
		return
	}
	if c.Kind != kind { // a channel from before names were checked
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeNameTaken,
			Detail: "A channel holds this conversation's name."})
		return
	}
	// Everyone is (again) a member: a direct conversation someone left comes back.
	for _, id := range ids {
		n, err := h.Queries.AddMember(r.Context(), store.AddMemberParams{ChannelID: c.ID, UserID: pgUUID(uuidFrom(id)), Role: RoleMember})
		if err != nil {
			h.unavailable(w, r, "add conversation member", err)
			return
		}
		if n > 0 {
			h.publish(r.Context(), events.ChannelJoined, ChannelEvent{Channel: toAPI(c, access{ch: RoleMember}), UserID: id})
		}
	}
	out := toAPI(c, access{ch: RoleMember, ws: wsRole})
	out.Participants = people
	httpx.WriteJSON(w, status, out)
}

func uuidFrom(s string) openapi_types.UUID {
	var id openapi_types.UUID
	_ = id.UnmarshalText([]byte(s))
	return id
}

// participants returns the other people of the user's conversations by
// channel id.
func (h *Handlers) participants(ctx context.Context, user pgtype.UUID) (map[openapi_types.UUID][]api.Person, error) {
	rows, err := h.Queries.ListConversationParticipants(ctx, user)
	if err != nil {
		return nil, err
	}
	out := map[openapi_types.UUID][]api.Person{}
	for _, row := range rows {
		id := uuid(row.ChannelID)
		out[id] = append(out[id], api.Person{Id: uuid(row.UserID), DisplayName: row.DisplayName, Email: row.Email})
	}
	return out, nil
}

// ReadEvent is the data of channel.read, for the reader's other devices.
type ReadEvent struct {
	UserID    string `json:"user_id"`
	ChannelID string `json:"channel_id"`
	MessageID string `json:"message_id"`
}

// MarkRead implements api.ServerInterface.
func (h *Handlers) MarkRead(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.MarkReadJSONBody
	if !decode(w, r, &in) {
		return
	}
	c, _, ok := h.memberChannel(w, r, channelID, p.User)
	if !ok {
		return
	}
	var message pgtype.UUID
	if in.MessageId != nil {
		message = pgUUID(*in.MessageId)
		// The read position is a message of this channel: a made-up one would
		// stop the unread count and tell the others in a conversation too much.
		if _, err := h.Queries.GetMessage(r.Context(), store.GetMessageParams{ID: message, ChannelID: c.ID}); isNoRows(err) {
			badRequest(w, r, "The message is not in this channel.")
			return
		} else if err != nil {
			h.unavailable(w, r, "get message", err)
			return
		}
	} else {
		id, err := h.Queries.NewestTimelineMessage(r.Context(), c.ID)
		if isNoRows(err) {
			w.WriteHeader(http.StatusNoContent)
			return
		} else if err != nil {
			h.unavailable(w, r, "newest message", err)
			return
		}
		message = id
	}
	if err := h.markRead(r.Context(), c.ID, p.User.ID, message); err != nil {
		h.unavailable(w, r, "mark read", err)
		return
	}
	// With read receipts, the others in the conversation who share theirs see
	// it too (receipts go both ways, as in ListConversationReads).
	if c.Kind == KindDirect || c.Kind == KindGroup {
		allowed, err := h.Queries.ReceiptsAllowed(r.Context(), store.ReceiptsAllowedParams{ChannelID: c.ID, UserID: p.User.ID})
		var sharing []store.ConversationReadsRow
		if err == nil && allowed {
			sharing, err = h.Queries.ConversationReads(r.Context(), store.ConversationReadsParams{ChannelID: c.ID, UserID: p.User.ID})
		}
		if err == nil && len(sharing) > 0 {
			to := make([]string, 0, len(sharing))
			for _, m := range sharing {
				to = append(to, uuid(m.UserID).String())
			}
			h.publish(r.Context(), events.ConversationRead, ConversationReadEvent{
				ChannelID: uuid(c.ID).String(), UserID: uuid(p.User.ID).String(), MessageID: uuid(message).String(), To: to,
			})
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// ConversationReadEvent is the data of conversation.read: someone in a
// conversation read up to a message (read receipts).
type ConversationReadEvent struct {
	ChannelID string `json:"channel_id"`
	UserID    string `json:"user_id"`
	MessageID string `json:"message_id"`
	// To: the members who see it (those who share their read receipts).
	To []string `json:"to"`
}

// ListConversationReads implements api.ServerInterface.
func (h *Handlers) ListConversationReads(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	c, _, ok := h.memberChannel(w, r, channelID, p.User)
	if !ok {
		return
	}
	type read struct {
		UserID     openapi_types.UUID  `json:"user_id"`
		LastReadID *openapi_types.UUID `json:"last_read_id"`
	}
	out := struct {
		Enabled bool   `json:"enabled"`
		Reads   []read `json:"reads"`
	}{Reads: []read{}}
	allowed, err := h.Queries.ReceiptsAllowed(r.Context(), store.ReceiptsAllowedParams{ChannelID: c.ID, UserID: p.User.ID})
	if err != nil {
		h.unavailable(w, r, "read receipts", err)
		return
	}
	if allowed {
		out.Enabled = true
		rows, err := h.Queries.ConversationReads(r.Context(), store.ConversationReadsParams{ChannelID: c.ID, UserID: p.User.ID})
		if err != nil {
			h.unavailable(w, r, "read receipts", err)
			return
		}
		for _, row := range rows {
			rd := read{UserID: uuid(row.UserID)}
			if row.LastReadID.Valid {
				id := uuid(row.LastReadID)
				rd.LastReadID = &id
			}
			out.Reads = append(out.Reads, rd)
		}
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// markRead moves the read position and tells the user's other devices.
func (h *Handlers) markRead(ctx context.Context, channel, user, message pgtype.UUID) error {
	n, err := h.Queries.MarkRead(ctx, store.MarkReadParams{ChannelID: channel, UserID: user, MessageID: message})
	if err != nil {
		return err
	}
	if n > 0 {
		h.publish(ctx, events.ChannelRead, ReadEvent{
			UserID: uuid(user).String(), ChannelID: uuid(channel).String(), MessageID: uuid(message).String(),
		})
	}
	return nil
}

// UnreadEvent is the data of channel.unread: the member's new read position
// (null when the whole channel is unread).
type UnreadEvent struct {
	UserID     string  `json:"user_id"`
	ChannelID  string  `json:"channel_id"`
	LastReadID *string `json:"last_read_id"`
}

// MarkUnread implements api.ServerInterface.
func (h *Handlers) MarkUnread(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.MarkUnreadJSONBody
	if r.ContentLength != 0 && !decode(w, r, &in) {
		return
	}
	c, _, ok := h.memberChannel(w, r, channelID, p.User)
	if !ok {
		return
	}
	ctx := r.Context()
	var message pgtype.UUID
	inChannel := true
	var root pgtype.UUID
	if in.MessageId == nil {
		id, err := h.Queries.NewestChannelMessage(ctx, store.NewestChannelMessageParams{ChannelID: c.ID, UserID: p.User.ID})
		if isNoRows(err) {
			w.WriteHeader(http.StatusNoContent)
			return
		} else if err != nil {
			h.unavailable(w, r, "newest message", err)
			return
		}
		message = id
	} else {
		m, ok := h.messageAnywhere(w, r, *in.MessageId, p.User)
		if !ok {
			return
		}
		if m.ChannelID != c.ID {
			httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound,
				Detail: "No such message."})
			return
		}
		message, root = m.ID, m.RootID
		inChannel = !m.RootID.Valid || m.AlsoInChannel
	}
	err := h.inTx(ctx, func(q *store.Queries) error {
		if root.Valid {
			last, err := q.MarkThreadUnreadFrom(ctx, store.MarkThreadUnreadFromParams{
				UserID: p.User.ID, RootID: root, MessageID: message,
			})
			if err != nil {
				return err
			}
			if err := emit(ctx, q, events.ThreadRead, ThreadFollowEvent{
				UserID: uuid(p.User.ID).String(), RootID: uuid(root).String(), MessageID: optionalID(last),
			}); err != nil {
				return err
			}
		}
		if !inChannel {
			return nil
		}
		last, err := q.MarkUnreadFrom(ctx, store.MarkUnreadFromParams{
			ChannelID: c.ID, UserID: p.User.ID, MessageID: message,
		})
		if err != nil {
			return err
		}
		ev := UnreadEvent{UserID: uuid(p.User.ID).String(), ChannelID: uuid(c.ID).String()}
		if last.Valid {
			id := uuid(last).String()
			ev.LastReadID = &id
		}
		return emit(ctx, q, events.ChannelUnread, ev)
	})
	if err != nil {
		h.unavailable(w, r, "mark unread", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// optionalID is the text of an id, or "" when there is none.
func optionalID(id pgtype.UUID) string {
	if !id.Valid {
		return ""
	}
	return uuid(id).String()
}

// TypingEvent is the data of typing.
type TypingEvent struct {
	ChannelID   string `json:"channel_id"`
	UserID      string `json:"user_id"`
	DisplayName string `json:"display_name"`
}

// SendTyping implements api.ServerInterface.
func (h *Handlers) SendTyping(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	c, role, ok := h.memberChannel(w, r, channelID, p.User)
	if !ok {
		return
	}
	if !canPost(c, role) {
		forbidden(w, r, CodeReadOnlyChannel, "You cannot send messages in this channel.")
		return
	}
	user := uuid(p.User.ID).String()
	n, _, err := h.Limiter.Hit(r.Context(), "cenacle:typing:"+uuid(c.ID).String()+":"+user, TypingInterval)
	if err != nil {
		h.unavailable(w, r, "typing rate limit", err)
		return
	}
	if n == 1 && h.Ephemeral != nil {
		if err := h.Ephemeral.Publish(r.Context(), events.Typing, TypingEvent{
			ChannelID: uuid(c.ID).String(), UserID: user, DisplayName: p.User.DisplayName,
		}); err != nil {
			h.Log.WarnContext(r.Context(), "publish typing", "error", err)
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// ConversationKey is the kind and name of the conversation of these people
// (user ids), for tools that create conversations (import).
func ConversationKey(ids []string) (kind, key string) { return conversationKey(ids) }

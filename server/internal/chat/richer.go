// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/auth"
	"github.com/Cenacle-TR/cenacle/server/internal/events"
	"github.com/Cenacle-TR/cenacle/server/internal/httpx"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

// Limits and codes of richer messages.
const (
	MaxCustomEmoji   = 500
	MaxStickers      = 1000
	MaxStickerPacks  = 50
	CodeNameTakenEmj = "emoji_name_taken"
	CodeEmojiLimit   = "emoji_limit"
	CodeBurned       = "burned"
	CodeNotForBurn   = "not_for_burn"
)

// PresenceReader tells who is online (for @here).
type PresenceReader interface {
	Statuses(ctx context.Context, ids []string) (map[string]string, error)
}

var (
	firstLinkRE = regexp.MustCompile(`(?i)\bhttps?://[^\s<>()\[\]"']+`)
	// Mentions of many: @channel, @everyone, @here, @admins, @owners.
	broadcastRE = regexp.MustCompile(`(?i)(?:^|[^\w@])@(channel|everyone|all|kanal|herkes|here|burada|admins|owners)\b`)
)

// firstLink returns the first web address of a text, without trailing
// punctuation; links in angle brackets (<https://…>) ask for no preview.
func firstLink(body string) string {
	for _, loc := range firstLinkRE.FindAllStringIndex(body, -1) {
		if loc[0] > 0 && body[loc[0]-1] == '<' {
			continue
		}
		link := strings.TrimRight(body[loc[0]:loc[1]], ".,;:!?")
		if u, err := url.Parse(link); err == nil && u.Host != "" && len(link) <= 2048 {
			return link
		}
	}
	return ""
}

// broadcasts returns the mentions of many in a text: "channel", "here",
// "role:admin", "role:owner".
func broadcasts(body string) []string {
	var out []string
	add := func(s string) {
		for _, o := range out {
			if o == s {
				return
			}
		}
		out = append(out, s)
	}
	for _, m := range broadcastRE.FindAllStringSubmatch(body, -1) {
		switch strings.ToLower(m[1]) {
		// Everyone in the channel, in English and Turkish (@all is what many type).
		case "channel", "everyone", "all", "kanal", "herkes":
			add("channel")
		// The people online now.
		case "here", "burada":
			add("here")
		case "admins":
			add("role:admin")
		case "owners":
			add("role:owner")
		}
	}
	return out
}

// addBroadcastMentions records the people a message's mentions of many reach.
// Without presence (bots, scheduled messages) @here reaches no one.
func addBroadcastMentions(ctx context.Context, q *store.Queries, presence PresenceReader, c store.Channel, msg store.Message) error {
	for _, b := range broadcasts(msg.Body) {
		arg := store.AddBroadcastMentionsParams{MessageID: msg.ID, ChannelID: c.ID, AuthorID: msg.AuthorID}
		switch b {
		case "channel":
			arg.Kind = "channel"
		case "here":
			arg.Kind = "here"
			arg.Users = []pgtype.UUID{}
			if presence != nil {
				members, err := q.ListMemberIDs(ctx, c.ID)
				if err != nil {
					return err
				}
				ids := make([]string, len(members))
				for i, m := range members {
					ids[i] = uuid(m).String()
				}
				statuses, err := presence.Statuses(ctx, ids)
				if err != nil {
					return err
				}
				for i, m := range members {
					if s := statuses[ids[i]]; s != "" && s != "offline" {
						arg.Users = append(arg.Users, m)
					}
				}
			}
		default:
			arg.Kind = "role"
			arg.Roles = []string{strings.TrimPrefix(b, "role:")}
			if arg.Roles[0] == "admin" {
				arg.Roles = append(arg.Roles, "owner") // owners administer too
			}
		}
		if err := q.AddBroadcastMentions(ctx, arg); err != nil {
			return err
		}
	}
	return nil
}

// richExtras checks a new message's sticker, burn-on-read and link.
func (h *Handlers) richExtras(r *http.Request, c store.Channel, in api.NewMessage, body string, out *postExtras) string {
	if in.StickerId != nil {
		s, err := h.Queries.GetSticker(r.Context(), pgUUID(*in.StickerId))
		if err != nil || s.WorkspaceID != c.WorkspaceID || s.RemovedAt.Valid {
			return "No such sticker in this workspace."
		}
		out.sticker = s.ID
	}
	if in.BurnSeconds != nil {
		switch {
		case !isConversation(c):
			return "Burn-on-read is for direct and group conversations."
		case *in.BurnSeconds < 10 || *in.BurnSeconds > 86400:
			return "burn_seconds must be between 10 and 86400."
		case in.RootId != nil || in.Poll != nil || out.sticker.Valid || (in.FileIds != nil && len(*in.FileIds) > 0):
			return "A burn-on-read message is text only."
		}
		out.burn = pgtype.Int4{Int32: int32(*in.BurnSeconds), Valid: true} //nolint:gosec // checked above
		return ""
	}
	if link := firstLink(body); link != "" && h.LinkPreviews && !c.Encrypted {
		out.link = pgtype.Text{String: link, Valid: true}
	}
	return ""
}

// richMessages fills the parts of messages that depend on other tables or
// on the reader: link previews, stickers, burn-on-read.
func richMessages(ctx context.Context, q store.Querier, reader pgtype.UUID, msgs []api.Message, index map[openapi_types.UUID]int, ids []pgtype.UUID) error {
	previews, err := q.ListLinkPreviews(ctx, ids)
	if err != nil {
		return err
	}
	for _, p := range previews {
		lp := &api.LinkPreview{Url: p.Url, Title: p.Title, Description: p.Description, SiteName: p.SiteName}
		if p.ImageID.Valid {
			lp.ImageUrl = pictureURL(p.ImageID, false)
		}
		msgs[index[uuid(p.MessageID)]].LinkPreview = lp
	}
	var stickerIDs []pgtype.UUID
	var burned []pgtype.UUID
	for _, m := range msgs {
		if m.Sticker != nil {
			stickerIDs = append(stickerIDs, pgUUID(m.Sticker.Id))
		}
		if m.Burn != nil && m.Author.Id != uuid(reader) {
			burned = append(burned, pgUUID(m.Id))
		}
	}
	if len(stickerIDs) > 0 {
		list, err := q.ListStickersByID(ctx, stickerIDs)
		if err != nil {
			return err
		}
		byID := map[openapi_types.UUID]store.Sticker{}
		for _, s := range list {
			byID[uuid(s.ID)] = s
		}
		for i, m := range msgs {
			if m.Sticker == nil {
				continue
			}
			if s, ok := byID[m.Sticker.Id]; ok {
				msgs[i].Sticker = ptr(stickerAPI(s))
			} else {
				msgs[i].Sticker = nil
			}
		}
	}
	if len(burned) > 0 {
		reveals, err := q.ListBurnReveals(ctx, store.ListBurnRevealsParams{UserID: reader, MessageIds: burned})
		if err != nil {
			return err
		}
		seen := map[openapi_types.UUID]time.Time{}
		for _, r := range reveals {
			seen[uuid(r.MessageID)] = r.RevealedAt
		}
		for i, m := range msgs {
			if m.Burn == nil || m.Author.Id == uuid(reader) {
				continue
			}
			at, ok := seen[m.Id]
			if ok {
				msgs[i].Burn.RevealedAt = &at
			}
			if !ok || time.Since(at) > time.Duration(m.Burn.Seconds)*time.Second {
				hideBurn(&msgs[i])
			}
		}
	}
	return nil
}

// hideBurn leaves a burn-on-read message's text out.
func hideBurn(m *api.Message) {
	m.Body = ""
	m.Mentions = []api.Author{}
	m.LinkPreview = nil
	if m.Burn != nil {
		m.Burn.Hidden = true
	}
}

func stickerAPI(s store.Sticker) api.Sticker {
	out := api.Sticker{Id: uuid(s.ID), Name: s.Name, Url: *pictureURL(s.PictureID, false), PackId: uuidPtr(s.PackID)}
	if s.CreatedBy.Valid {
		out.CreatedBy = ptr(uuid(s.CreatedBy))
	}
	return out
}

func stickerPackAPI(k store.StickerPack) api.StickerPack {
	return api.StickerPack{Id: uuid(k.ID), Name: k.Name, CreatedBy: uuidPtr(k.CreatedBy), CreatedAt: k.CreatedAt}
}

func emojiAPI(e store.CustomEmoji) api.CustomEmoji {
	out := api.CustomEmoji{Id: uuid(e.ID), Name: e.Name, Url: *pictureURL(e.PictureID, false)}
	if e.CreatedBy.Valid {
		out.CreatedBy = ptr(uuid(e.CreatedBy))
	}
	return out
}

// ------------------------------------------------------------- forwarding ---

type forwardSnapshot struct {
	MessageID   string     `json:"message_id"`
	ChannelID   string     `json:"channel_id"`
	ChannelName string     `json:"channel_name"`
	Author      api.Author `json:"author"`
	Body        string     `json:"body"`
	CreatedAt   time.Time  `json:"created_at"`
}

// ForwardMessage implements api.ServerInterface.
func (h *Handlers) ForwardMessage(w http.ResponseWriter, r *http.Request, channelID, messageID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.ForwardMessageJSONBody
	if !decode(w, r, &in) {
		return
	}
	comment := ""
	if in.Comment != nil {
		comment = strings.TrimSpace(*in.Comment)
	}
	if utf8.RuneCountInString(comment) > MaxBodyLength {
		badRequest(w, r, "The comment is longer than 4000 characters.")
		return
	}
	from, _, m, ok := h.message(w, r, channelID, messageID, p.User)
	if !ok {
		return
	}
	switch {
	case m.DeletedAt.Valid:
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "The message was deleted."})
		return
	case m.BurnSeconds.Valid:
		forbidden(w, r, CodeNotForBurn, "Burn-on-read messages cannot be forwarded.")
		return
	}
	to, role, ok := h.memberChannel(w, r, in.ChannelId, p.User)
	if !ok {
		return
	}
	if from.Encrypted || to.Encrypted { // the text would leave (or enter) unreadable
		refuseEncrypted(w, r)
		return
	}
	if !canPost(to, role) {
		forbidden(w, r, CodeReadOnlyChannel, "You cannot post in that channel.")
		return
	}
	if h.timedOut(w, r, to.WorkspaceID, p.User) || !h.allowMessage(w, r, p.User) {
		return
	}
	noGroups, ok := h.mentionRights(w, r, to, role, comment)
	if !ok {
		return
	}
	flags, ok := h.automod(w, r, to, role, comment)
	if !ok {
		return
	}
	name := from.Name
	if isConversation(from) {
		name = ""
	}
	snap, _ := json.Marshal(forwardSnapshot{
		MessageID: uuid(m.ID).String(), ChannelID: uuid(from.ID).String(), ChannelName: name,
		Author: api.Author{Id: uuid(m.AuthorID), DisplayName: m.AuthorName}, Body: m.Body, CreatedAt: m.CreatedAt,
	})
	var out api.Message
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		var err error
		out, err = postMessageTo(r.Context(), q, to, p.User, comment, "fwd-"+randomNonce(), []byte("[]"), replyTo{}, postExtras{forward: snap, presence: h.Presence, noGroups: noGroups})
		if err != nil {
			return err
		}
		return flagMessage(r.Context(), q, to, out.Id, flags)
	})
	if err != nil {
		h.unavailable(w, r, "forward message", err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, out)
}

// ------------------------------------------------------------ link preview ---

// LinkPreviewEvent is the data of message.preview (Preview null: none).
type LinkPreviewEvent struct {
	ChannelID string           `json:"channel_id"`
	MessageID string           `json:"message_id"`
	Preview   *api.LinkPreview `json:"link_preview"`
}

// HideLinkPreview implements api.ServerInterface.
func (h *Handlers) HideLinkPreview(w http.ResponseWriter, r *http.Request, channelID, messageID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	c, _, m, ok := h.message(w, r, channelID, messageID, p.User)
	if !ok {
		return
	}
	if m.AuthorID != p.User.ID {
		forbidden(w, r, httpx.CodeForbidden, "Only the author removes a message's preview.")
		return
	}
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		if err := q.SetLinkState(r.Context(), store.SetLinkStateParams{ID: m.ID, LinkState: pgtype.Text{String: "hidden", Valid: true}}); err != nil {
			return err
		}
		return emit(r.Context(), q, events.MessagePreview, LinkPreviewEvent{ChannelID: uuid(c.ID).String(), MessageID: uuid(m.ID).String()})
	})
	if err != nil {
		h.unavailable(w, r, "hide preview", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ----------------------------------------------------------- burn-on-read ---

// RevealMessage implements api.ServerInterface.
func (h *Handlers) RevealMessage(w http.ResponseWriter, r *http.Request, channelID, messageID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	_, _, m, ok := h.message(w, r, channelID, messageID, p.User)
	if !ok {
		return
	}
	if m.DeletedAt.Valid || !m.BurnSeconds.Valid {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No such burn-on-read message."})
		return
	}
	at, err := h.Queries.RevealBurn(r.Context(), store.RevealBurnParams{MessageID: m.ID, UserID: p.User.ID})
	if err != nil {
		h.unavailable(w, r, "reveal", err)
		return
	}
	if m.AuthorID != p.User.ID && time.Since(at) > time.Duration(m.BurnSeconds.Int32)*time.Second {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusGone, Code: CodeBurned, Detail: "This message has burned."})
		return
	}
	msgs := []api.Message{messageAPI(storeMessage(m), m.AuthorName, m.AuthorIsBot)}
	if err := decorate(r.Context(), h.Queries, p.User.ID, msgs); err != nil {
		h.unavailable(w, r, "decorate", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, msgs[0])
}

// PurgeBurned removes burn-on-read messages everyone has read (a periodic job).
func (p Purger) PurgeBurned(ctx context.Context) (int64, error) {
	return p.Queries.PurgeBurned(ctx)
}

// ------------------------------------------------------ emoji and stickers ---

var emojiNameRE = regexp.MustCompile(`^[a-z0-9_+-]{2,32}$`)

// customEmojiName returns the name of a custom emoji reaction (":name:"),
// or "" when it is not one.
func customEmojiName(s string) string {
	if len(s) < 4 || s[0] != ':' || s[len(s)-1] != ':' || !emojiNameRE.MatchString(s[1:len(s)-1]) {
		return ""
	}
	return s[1 : len(s)-1]
}

// ListCustomEmoji implements api.ServerInterface.
func (h *Handlers) ListCustomEmoji(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	if _, ok := h.workspaceRole(w, r, workspaceID, p.User); !ok {
		return
	}
	list, err := h.Queries.ListCustomEmoji(r.Context(), pgUUID(workspaceID))
	if err != nil {
		h.unavailable(w, r, "list emoji", err)
		return
	}
	out := make([]api.CustomEmoji, len(list))
	for i, e := range list {
		out[i] = emojiAPI(e)
	}
	httpx.WriteJSON(w, http.StatusOK, map[string][]api.CustomEmoji{"emoji": out})
}

// EmojiEvent is the data of emoji.changed: a workspace's emoji or stickers changed.
type EmojiEvent struct {
	WorkspaceID string `json:"workspace_id"`
}

// AddCustomEmoji implements api.ServerInterface.
func (h *Handlers) AddCustomEmoji(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID, params api.AddCustomEmojiParams) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	if _, _, ok := h.requirePermission(w, r, workspaceID, p.User, PermEmoji, "Your role in this workspace does not add emoji."); !ok {
		return
	}
	if !emojiNameRE.MatchString(params.Name) {
		badRequest(w, r, "A name has 2 to 32 lowercase letters, digits, _, + or -.")
		return
	}
	n, err := h.Queries.CountCustomEmoji(r.Context(), pgUUID(workspaceID))
	if err != nil {
		h.unavailable(w, r, "count emoji", err)
		return
	}
	if n >= MaxCustomEmoji {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeEmojiLimit, Detail: "A workspace has up to 500 custom emoji."})
		return
	}
	pic, ok := readPicture(w, r)
	if !ok {
		return
	}
	var e store.CustomEmoji
	err = h.inTx(r.Context(), func(q *store.Queries) error {
		id, err := h.insertPicture(r.Context(), q, pic)
		if err != nil {
			return err
		}
		if e, err = q.CreateCustomEmoji(r.Context(), store.CreateCustomEmojiParams{
			WorkspaceID: pgUUID(workspaceID), Name: params.Name, PictureID: id, CreatedBy: p.User.ID,
		}); err != nil {
			return err
		}
		return emit(r.Context(), q, events.EmojiChanged, EmojiEvent{WorkspaceID: workspaceID.String()})
	})
	if isUniqueViolation(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeNameTakenEmj, Detail: "An emoji with this name exists."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "add emoji", err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, emojiAPI(e))
}

// DeleteCustomEmoji implements api.ServerInterface.
func (h *Handlers) DeleteCustomEmoji(w http.ResponseWriter, r *http.Request, emojiID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	e, err := h.Queries.GetCustomEmoji(r.Context(), pgUUID(emojiID))
	if isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No such emoji."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "get emoji", err)
		return
	}
	role, ok := h.workspaceRole(w, r, uuid(e.WorkspaceID), p.User)
	if !ok {
		return
	}
	if e.CreatedBy != p.User.ID && !isWorkspaceAdmin(role) {
		forbidden(w, r, httpx.CodeForbidden, "Only who added it or a workspace admin removes an emoji.")
		return
	}
	err = h.inTx(r.Context(), func(q *store.Queries) error {
		if err := q.DeleteCustomEmoji(r.Context(), e.ID); err != nil {
			return err
		}
		if err := q.DeletePicture(r.Context(), e.PictureID); err != nil {
			return err
		}
		return emit(r.Context(), q, events.EmojiChanged, EmojiEvent{WorkspaceID: uuid(e.WorkspaceID).String()})
	})
	if err != nil {
		h.unavailable(w, r, "delete emoji", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ListStickers implements api.ServerInterface.
func (h *Handlers) ListStickers(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	if _, ok := h.workspaceRole(w, r, workspaceID, p.User); !ok {
		return
	}
	list, err := h.Queries.ListStickers(r.Context(), pgUUID(workspaceID))
	if err != nil {
		h.unavailable(w, r, "list stickers", err)
		return
	}
	out := make([]api.Sticker, len(list))
	for i, s := range list {
		out[i] = stickerAPI(s)
	}
	httpx.WriteJSON(w, http.StatusOK, map[string][]api.Sticker{"stickers": out})
}

// AddSticker implements api.ServerInterface.
func (h *Handlers) AddSticker(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID, params api.AddStickerParams) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	role, ok := h.workspaceRole(w, r, workspaceID, p.User)
	if !ok {
		return
	}
	if role == WorkspaceGuest {
		forbidden(w, r, httpx.CodeForbidden, "Guests do not add stickers.")
		return
	}
	name := strings.TrimSpace(params.Name)
	if name == "" || utf8.RuneCountInString(name) > 40 {
		badRequest(w, r, "A name has 1 to 40 characters.")
		return
	}
	var pack pgtype.UUID
	if params.PackId != nil {
		k, err := h.Queries.GetStickerPack(r.Context(), pgUUID(*params.PackId))
		if isNoRows(err) || (err == nil && k.WorkspaceID != pgUUID(workspaceID)) {
			badRequest(w, r, "No such sticker pack in this workspace.")
			return
		}
		if err != nil {
			h.unavailable(w, r, "get sticker pack", err)
			return
		}
		if k.CreatedBy != p.User.ID && !isWorkspaceAdmin(role) {
			forbidden(w, r, httpx.CodeForbidden, "Only who made a pack or a workspace admin adds to it.")
			return
		}
		pack = k.ID
	}
	n, err := h.Queries.CountStickers(r.Context(), pgUUID(workspaceID))
	if err != nil {
		h.unavailable(w, r, "count stickers", err)
		return
	}
	if n >= MaxStickers {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeEmojiLimit, Detail: "A workspace has up to 1000 stickers."})
		return
	}
	pic, ok := readPicture(w, r)
	if !ok {
		return
	}
	var s store.Sticker
	err = h.inTx(r.Context(), func(q *store.Queries) error {
		id, err := h.insertPicture(r.Context(), q, pic)
		if err != nil {
			return err
		}
		if s, err = q.CreateSticker(r.Context(), store.CreateStickerParams{
			WorkspaceID: pgUUID(workspaceID), Name: name, PictureID: id, CreatedBy: p.User.ID, PackID: pack,
		}); err != nil {
			return err
		}
		return emit(r.Context(), q, events.EmojiChanged, EmojiEvent{WorkspaceID: workspaceID.String()})
	})
	if err != nil {
		h.unavailable(w, r, "add sticker", err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, stickerAPI(s))
}

// DeleteSticker implements api.ServerInterface.
func (h *Handlers) DeleteSticker(w http.ResponseWriter, r *http.Request, stickerID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	s, err := h.Queries.GetSticker(r.Context(), pgUUID(stickerID))
	if isNoRows(err) || (err == nil && s.RemovedAt.Valid) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No such sticker."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "get sticker", err)
		return
	}
	role, ok := h.workspaceRole(w, r, uuid(s.WorkspaceID), p.User)
	if !ok {
		return
	}
	if s.CreatedBy != p.User.ID && !isWorkspaceAdmin(role) {
		forbidden(w, r, httpx.CodeForbidden, "Only who added it or a workspace admin removes a sticker.")
		return
	}
	err = h.inTx(r.Context(), func(q *store.Queries) error {
		if err := removeSticker(r.Context(), q, s); err != nil {
			return err
		}
		return emit(r.Context(), q, events.EmojiChanged, EmojiEvent{WorkspaceID: uuid(s.WorkspaceID).String()})
	})
	if err != nil {
		h.unavailable(w, r, "delete sticker", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// removeSticker takes a sticker out of the picker: one some message shows is
// only hidden (the message keeps showing it), any other goes with its picture.
func removeSticker(ctx context.Context, q *store.Queries, s store.Sticker) error {
	n, err := q.HideUsedSticker(ctx, s.ID)
	if err != nil || n > 0 {
		return err
	}
	if err := q.DeleteSticker(ctx, s.ID); err != nil {
		return err
	}
	_, err = q.DeletePictureIfUnused(ctx, s.PictureID)
	return err
}

// ListStickerPacks implements api.ServerInterface.
func (h *Handlers) ListStickerPacks(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	if _, ok := h.workspaceRole(w, r, workspaceID, p.User); !ok {
		return
	}
	list, err := h.Queries.ListStickerPacks(r.Context(), pgUUID(workspaceID))
	if err != nil {
		h.unavailable(w, r, "list sticker packs", err)
		return
	}
	out := make([]api.StickerPack, len(list))
	for i, k := range list {
		out[i] = stickerPackAPI(k)
	}
	httpx.WriteJSON(w, http.StatusOK, map[string][]api.StickerPack{"packs": out})
}

// CreateStickerPack implements api.ServerInterface.
func (h *Handlers) CreateStickerPack(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.CreateStickerPackJSONBody
	if !decode(w, r, &in) {
		return
	}
	role, ok := h.workspaceRole(w, r, workspaceID, p.User)
	if !ok {
		return
	}
	if role == WorkspaceGuest {
		forbidden(w, r, httpx.CodeForbidden, "Guests do not add stickers.")
		return
	}
	name := strings.TrimSpace(in.Name)
	if name == "" || utf8.RuneCountInString(name) > 40 {
		badRequest(w, r, "A name has 1 to 40 characters.")
		return
	}
	n, err := h.Queries.CountStickerPacks(r.Context(), pgUUID(workspaceID))
	if err != nil {
		h.unavailable(w, r, "count sticker packs", err)
		return
	}
	if n >= MaxStickerPacks {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeEmojiLimit, Detail: "A workspace has up to 50 sticker packs."})
		return
	}
	var k store.StickerPack
	err = h.inTx(r.Context(), func(q *store.Queries) error {
		if k, err = q.CreateStickerPack(r.Context(), store.CreateStickerPackParams{
			WorkspaceID: pgUUID(workspaceID), Name: name, CreatedBy: p.User.ID,
		}); err != nil {
			return err
		}
		return emit(r.Context(), q, events.EmojiChanged, EmojiEvent{WorkspaceID: workspaceID.String()})
	})
	if err != nil {
		h.unavailable(w, r, "create sticker pack", err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, stickerPackAPI(k))
}

// DeleteStickerPack implements api.ServerInterface.
func (h *Handlers) DeleteStickerPack(w http.ResponseWriter, r *http.Request, packID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	k, err := h.Queries.GetStickerPack(r.Context(), pgUUID(packID))
	if isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No such sticker pack."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "get sticker pack", err)
		return
	}
	role, ok := h.workspaceRole(w, r, uuid(k.WorkspaceID), p.User)
	if !ok {
		return
	}
	if k.CreatedBy != p.User.ID && !isWorkspaceAdmin(role) {
		forbidden(w, r, httpx.CodeForbidden, "Only who made it or a workspace admin removes a sticker pack.")
		return
	}
	err = h.inTx(r.Context(), func(q *store.Queries) error {
		stickers, err := q.ListPackStickers(r.Context(), k.ID)
		if err != nil {
			return err
		}
		for _, s := range stickers {
			if err := removeSticker(r.Context(), q, s); err != nil {
				return err
			}
		}
		if err := q.DeleteStickerPack(r.Context(), k.ID); err != nil {
			return err
		}
		return emit(r.Context(), q, events.EmojiChanged, EmojiEvent{WorkspaceID: uuid(k.WorkspaceID).String()})
	})
	if err != nil {
		h.unavailable(w, r, "delete sticker pack", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

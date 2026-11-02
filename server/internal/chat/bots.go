// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"slices"
	"strconv"
	"time"

	guuid "github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/audit"
	"github.com/barisshn35/cenacle/server/internal/auth"
	"github.com/barisshn35/cenacle/server/internal/events"
	"github.com/barisshn35/cenacle/server/internal/httpx"
	"github.com/barisshn35/cenacle/server/internal/integrations/alertmanager"
	"github.com/barisshn35/cenacle/server/internal/integrations/email"
	"github.com/barisshn35/cenacle/server/internal/integrations/github"
	"github.com/barisshn35/cenacle/server/internal/integrations/gitlab"
	"github.com/barisshn35/cenacle/server/internal/integrations/jira"
	"github.com/barisshn35/cenacle/server/internal/store"
)

// Problem codes of bots and webhooks.
const (
	CodeBotNotInChannel = "bot_not_in_channel"
	CodeUnknownEvent    = "unknown_event"
)

// maxHookBody bounds webhook payloads (Jira's carry the whole issue).
const maxHookBody = 1 << 20

// maxMailBody is the largest e-mail an e-mail webhook takes.
const maxMailBody = 10 << 20

func botAPI(b store.Bot, name string) api.Bot {
	return api.Bot{
		Id: uuid(b.ID), UserId: uuid(b.UserID), Name: name, Description: b.Description,
		Disabled: b.DisabledAt.Valid, CreatedAt: b.CreatedAt,
		InteractionsUrl: textPtr(b.InteractionsUrl),
	}
}

func textPtr(t pgtype.Text) *string {
	if !t.Valid {
		return nil
	}
	return &t.String
}

func tsPtr(t pgtype.Timestamptz) *time.Time {
	if !t.Valid {
		return nil
	}
	v := t.Time
	return &v
}

func tokenAPI(t store.BotToken) api.BotToken {
	return api.BotToken{Id: uuid(t.ID), Name: t.Name, Scopes: t.Scopes, CreatedAt: t.CreatedAt,
		LastUsedAt: tsPtr(t.LastUsedAt), ExpiresAt: tsPtr(t.ExpiresAt)}
}

// managedBot loads a bot of a workspace the user owns or administers.
func (h *Handlers) managedBot(w http.ResponseWriter, r *http.Request, id openapi_types.UUID, user store.User) (store.GetBotRow, bool) {
	b, err := h.Queries.GetBot(r.Context(), pgUUID(id))
	if isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No bot with this id."})
		return b, false
	}
	if err != nil {
		h.unavailable(w, r, "get bot", err)
		return b, false
	}
	role, ok := h.workspaceRole(w, r, uuid(b.Bot.WorkspaceID), user)
	if !ok {
		return b, false
	}
	if !isWorkspaceAdmin(role) {
		forbidden(w, r, httpx.CodeForbidden, "Only the workspace's owners and admins manage bots.")
		return b, false
	}
	return b, true
}

// ListBots implements api.ServerInterface.
func (h *Handlers) ListBots(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	role, ok := h.workspaceRole(w, r, workspaceID, p.User)
	if !ok {
		return
	}
	if !isWorkspaceAdmin(role) {
		forbidden(w, r, httpx.CodeForbidden, "Only the workspace's owners and admins manage bots.")
		return
	}
	rows, err := h.Queries.ListBots(r.Context(), pgUUID(workspaceID))
	if err != nil {
		h.unavailable(w, r, "list bots", err)
		return
	}
	out := make([]api.Bot, 0, len(rows))
	for _, b := range rows {
		out = append(out, botAPI(b.Bot, b.DisplayName))
	}
	httpx.WriteJSON(w, http.StatusOK, struct {
		Bots []api.Bot `json:"bots"`
	}{out})
}

// CreateBot implements api.ServerInterface.
func (h *Handlers) CreateBot(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in struct {
		Name        string  `json:"name"`
		Description *string `json:"description"`
	}
	if !decode(w, r, &in) {
		return
	}
	role, ok := h.workspaceRole(w, r, workspaceID, p.User)
	if !ok {
		return
	}
	if !isWorkspaceAdmin(role) {
		forbidden(w, r, httpx.CodeForbidden, "Only the workspace's owners and admins manage bots.")
		return
	}
	name, problem := cleanName(in.Name)
	description := ""
	if problem == "" && in.Description != nil {
		description, problem = cleanTopic(*in.Description)
	}
	if problem != "" {
		badRequest(w, r, problem)
		return
	}
	var out api.Bot
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		id := guuid.Must(guuid.NewV7())
		u, err := q.CreateBotUser(r.Context(), store.CreateBotUserParams{AuthData: id.String(), DisplayName: name})
		if err != nil {
			return err
		}
		b, err := q.CreateBot(r.Context(), store.CreateBotParams{
			ID: pgUUID(id), WorkspaceID: pgUUID(workspaceID), UserID: u.ID, Description: description, CreatedBy: p.User.ID,
		})
		if err != nil {
			return err
		}
		if _, err := q.AddWorkspaceMember(r.Context(), store.AddWorkspaceMemberParams{
			WorkspaceID: pgUUID(workspaceID), UserID: u.ID, Role: WorkspaceMember,
		}); err != nil {
			return err
		}
		out = botAPI(b, name)
		return nil
	})
	if err != nil {
		h.unavailable(w, r, "create bot", err)
		return
	}
	h.record(r, pgUUID(workspaceID), audit.BotCreated, "bot", out.Id.String(), map[string]any{"name": name})
	httpx.WriteJSON(w, http.StatusCreated, out)
}

// UpdateBot implements api.ServerInterface.
func (h *Handlers) UpdateBot(w http.ResponseWriter, r *http.Request, botID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in struct {
		Name        *string `json:"name"`
		Description *string `json:"description"`
		Disabled    *bool   `json:"disabled"`
	}
	if !decode(w, r, &in) {
		return
	}
	b, ok := h.managedBot(w, r, botID, p.User)
	if !ok {
		return
	}
	name, description, problem := b.DisplayName, b.Bot.Description, ""
	if in.Name != nil {
		name, problem = cleanName(*in.Name)
	}
	if problem == "" && in.Description != nil {
		description, problem = cleanTopic(*in.Description)
	}
	if problem != "" {
		badRequest(w, r, problem)
		return
	}
	bot := b.Bot
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		if err := q.UpdateBot(r.Context(), store.UpdateBotParams{DisplayName: name, BotID: bot.ID}); err != nil {
			return err
		}
		if err := q.SetBotDescription(r.Context(), store.SetBotDescriptionParams{Description: description, ID: bot.ID}); err != nil {
			return err
		}
		if in.Disabled != nil {
			var err error
			bot, err = q.SetBotDisabled(r.Context(), store.SetBotDisabledParams{Disabled: *in.Disabled, ID: bot.ID})
			return err
		}
		return nil
	})
	if err != nil {
		h.unavailable(w, r, "update bot", err)
		return
	}
	bot.Description = description
	if in.Disabled != nil && *in.Disabled != b.Bot.DisabledAt.Valid {
		action := audit.BotEnabled
		if *in.Disabled {
			action = audit.BotDisabled
		}
		h.record(r, bot.WorkspaceID, action, "bot", botID.String(), map[string]any{"name": name})
	}
	httpx.WriteJSON(w, http.StatusOK, botAPI(bot, name))
}

// ListBotTokens implements api.ServerInterface.
func (h *Handlers) ListBotTokens(w http.ResponseWriter, r *http.Request, botID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	b, ok := h.managedBot(w, r, botID, p.User)
	if !ok {
		return
	}
	rows, err := h.Queries.ListBotTokens(r.Context(), b.Bot.ID)
	if err != nil {
		h.unavailable(w, r, "list tokens", err)
		return
	}
	out := make([]api.BotToken, 0, len(rows))
	for _, t := range rows {
		out = append(out, tokenAPI(t))
	}
	httpx.WriteJSON(w, http.StatusOK, struct {
		Tokens []api.BotToken `json:"tokens"`
	}{out})
}

// CreateBotToken implements api.ServerInterface.
func (h *Handlers) CreateBotToken(w http.ResponseWriter, r *http.Request, botID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in struct {
		Name          string   `json:"name"`
		Scopes        []string `json:"scopes"`
		ExpiresInDays *int     `json:"expires_in_days"`
	}
	if !decode(w, r, &in) {
		return
	}
	b, ok := h.managedBot(w, r, botID, p.User)
	if !ok {
		return
	}
	name, problem := cleanName(in.Name)
	scopes := []string{}
	for _, s := range in.Scopes {
		if s != auth.ScopeMessagesRead && s != auth.ScopeMessagesWrite {
			problem = "scopes are messages:read and messages:write."
		} else if !slices.Contains(scopes, s) {
			scopes = append(scopes, s)
		}
	}
	if problem == "" && len(scopes) == 0 {
		problem = "Give the token at least one scope."
	}
	var expires pgtype.Timestamptz
	if in.ExpiresInDays != nil {
		if *in.ExpiresInDays < 1 || *in.ExpiresInDays > 3650 {
			problem = "expires_in_days must be between 1 and 3650."
		}
		expires = pgtype.Timestamptz{Time: time.Now().AddDate(0, 0, *in.ExpiresInDays), Valid: true}
	}
	if problem != "" {
		badRequest(w, r, problem)
		return
	}
	secret, hash := auth.NewBotToken()
	t, err := h.Queries.CreateBotToken(r.Context(), store.CreateBotTokenParams{
		BotID: b.Bot.ID, Name: name, TokenHash: hash, Scopes: scopes, CreatedBy: p.User.ID, ExpiresAt: expires,
	})
	if err != nil {
		h.unavailable(w, r, "create token", err)
		return
	}
	h.record(r, b.Bot.WorkspaceID, audit.BotTokenCreated, "bot", botID.String(),
		map[string]any{"bot": b.DisplayName, "token": name, "scopes": scopes})
	httpx.WriteJSON(w, http.StatusCreated, struct {
		Token  api.BotToken `json:"token"`
		Secret string       `json:"secret"`
	}{tokenAPI(t), secret})
}

// RevokeBotToken implements api.ServerInterface.
func (h *Handlers) RevokeBotToken(w http.ResponseWriter, r *http.Request, botID, tokenID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	b, ok := h.managedBot(w, r, botID, p.User)
	if !ok {
		return
	}
	n, err := h.Queries.RevokeBotToken(r.Context(), store.RevokeBotTokenParams{ID: pgUUID(tokenID), BotID: b.Bot.ID})
	if err != nil {
		h.unavailable(w, r, "revoke token", err)
		return
	}
	if n == 0 {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No token with this id."})
		return
	}
	h.record(r, b.Bot.WorkspaceID, audit.BotTokenRevoked, "bot", botID.String(),
		map[string]any{"bot": b.DisplayName, "token_id": tokenID.String()})
	w.WriteHeader(http.StatusNoContent)
}

func webhookAPI(row store.ListWebhooksRow) api.Webhook {
	return api.Webhook{Id: uuid(row.ID), Name: row.Name, Kind: api.WebhookKind(row.Kind), ChannelId: uuid(row.ChannelID),
		ChannelName: row.ChannelName, CreatedAt: row.CreatedAt, LastUsedAt: tsPtr(row.LastUsedAt)}
}

// ListWebhooks implements api.ServerInterface.
func (h *Handlers) ListWebhooks(w http.ResponseWriter, r *http.Request, botID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	b, ok := h.managedBot(w, r, botID, p.User)
	if !ok {
		return
	}
	rows, err := h.Queries.ListWebhooks(r.Context(), b.Bot.ID)
	if err != nil {
		h.unavailable(w, r, "list webhooks", err)
		return
	}
	out := make([]api.Webhook, 0, len(rows))
	for _, row := range rows {
		out = append(out, webhookAPI(row))
	}
	httpx.WriteJSON(w, http.StatusOK, struct {
		Webhooks []api.Webhook `json:"webhooks"`
	}{out})
}

func hookSecret() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return "cnh_" + base64.RawURLEncoding.EncodeToString(b)
}

// CreateWebhook implements api.ServerInterface. The bot joins the channel.
func (h *Handlers) CreateWebhook(w http.ResponseWriter, r *http.Request, botID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in struct {
		Name      string             `json:"name"`
		ChannelID openapi_types.UUID `json:"channel_id"`
		Kind      string             `json:"kind"`
	}
	if !decode(w, r, &in) {
		return
	}
	b, ok := h.managedBot(w, r, botID, p.User)
	if !ok {
		return
	}
	name, problem := cleanName(in.Name)
	if problem == "" && !slices.Contains([]string{"generic", "jira", "gitlab", "alertmanager", "github", "email"}, in.Kind) {
		problem = "kind must be generic, jira, gitlab or alertmanager."
	}
	if problem != "" {
		badRequest(w, r, problem)
		return
	}
	c, _, ok := h.visibleChannel(w, r, in.ChannelID, p.User)
	if !ok {
		return
	}
	if c.WorkspaceID != b.Bot.WorkspaceID || isConversation(c) || c.ArchivedAt.Valid {
		badRequest(w, r, "The channel must be an open channel of the bot's workspace.")
		return
	}
	// The bot joins the channel: it must meet the channel's access rules.
	if !h.mayJoin(w, r, c, b.Bot.UserID) {
		return
	}
	secret := hookSecret()
	var out api.Webhook
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		wh, err := q.CreateWebhook(r.Context(), store.CreateWebhookParams{
			BotID: b.Bot.ID, ChannelID: c.ID, Kind: in.Kind, Name: name, TokenHash: auth.HashSecret(secret), CreatedBy: p.User.ID,
		})
		if err != nil {
			return err
		}
		n, err := q.AddMember(r.Context(), store.AddMemberParams{ChannelID: c.ID, UserID: b.Bot.UserID, Role: RoleMember})
		if err != nil {
			return err
		}
		if n > 0 {
			if err := emit(r.Context(), q, events.ChannelMembersChanged, ChannelEvent{ChannelID: uuid(c.ID).String()}); err != nil {
				return err
			}
		}
		out = webhookAPI(store.ListWebhooksRow{ID: wh.ID, ChannelID: wh.ChannelID, Kind: wh.Kind, Name: wh.Name,
			CreatedAt: wh.CreatedAt, ChannelName: c.Name})
		return nil
	})
	if err != nil {
		h.unavailable(w, r, "create webhook", err)
		return
	}
	h.record(r, b.Bot.WorkspaceID, audit.WebhookCreated, "bot", botID.String(),
		map[string]any{"bot": b.DisplayName, "webhook": name, "kind": in.Kind, "channel": c.Name})
	httpx.WriteJSON(w, http.StatusCreated, struct {
		Webhook api.Webhook `json:"webhook"`
		URL     string      `json:"url"`
	}{out, h.PublicURL + "/api/hooks/" + secret})
}

// DeleteWebhook implements api.ServerInterface.
func (h *Handlers) DeleteWebhook(w http.ResponseWriter, r *http.Request, botID, webhookID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	b, ok := h.managedBot(w, r, botID, p.User)
	if !ok {
		return
	}
	n, err := h.Queries.DeleteWebhook(r.Context(), store.DeleteWebhookParams{ID: pgUUID(webhookID), BotID: b.Bot.ID})
	if err != nil {
		h.unavailable(w, r, "delete webhook", err)
		return
	}
	if n == 0 {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No webhook with this id."})
		return
	}
	h.record(r, b.Bot.WorkspaceID, audit.WebhookDeleted, "bot", botID.String(),
		map[string]any{"bot": b.DisplayName, "webhook_id": webhookID.String()})
	w.WriteHeader(http.StatusNoContent)
}

// PostWebhook implements api.ServerInterface: no session, the URL is the
// secret. The message is posted as the bot.
func (h *Handlers) PostWebhook(w http.ResponseWriter, r *http.Request, token string) {
	notFound := func() {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound,
			Detail: "No webhook at this address, or its bot is disabled."})
	}
	if len(token) < 20 || len(token) > 100 {
		notFound()
		return
	}
	row, err := h.Queries.GetActiveWebhook(r.Context(), auth.HashSecret(token))
	if isNoRows(err) {
		notFound()
		return
	}
	if err != nil {
		h.unavailable(w, r, "get webhook", err)
		return
	}
	hook, bot := row.IncomingWebhook, row.User
	n, wait, err := h.Limiter.Hit(r.Context(), "cenacle:rl:hook:"+uuid(hook.ID).String(), h.Window)
	if err != nil {
		h.unavailable(w, r, "rate limit", err)
		return
	}
	if n > h.MessagesPerWindow {
		w.Header().Set("Retry-After", strconv.Itoa(int((wait+time.Second-1)/time.Second)))
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusTooManyRequests, Code: httpx.CodeRateLimited,
			Detail: "Too many messages in a short time."})
		return
	}
	limit, limitText := int64(maxHookBody), "1 MiB"
	if hook.Kind == "email" {
		// E-mails come with their attachments (only their names are shown).
		limit, limitText = maxMailBody, "10 MiB"
	}
	payload, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		badRequest(w, r, "The body is too large ("+limitText+" at most).")
		return
	}

	var body string
	var attachments *[]api.Attachment
	switch hook.Kind {
	case "jira", "gitlab", "alertmanager", "github", "email":
		format := map[string]func([]byte) (api.Attachment, bool, error){
			"jira": jira.Card, "gitlab": gitlab.Card, "alertmanager": alertmanager.Card, "email": email.Card,
			// GitHub names the event in a header.
			"github": func(b []byte) (api.Attachment, bool, error) { return github.Card(r.Header.Get("X-GitHub-Event"), b) },
		}[hook.Kind]
		card, ok, err := format(payload)
		if err != nil {
			badRequest(w, r, "The body is not a "+hook.Kind+" webhook event.")
			return
		}
		if !ok { // nothing worth posting; the sender expects success
			w.WriteHeader(http.StatusOK)
			return
		}
		attachments = &[]api.Attachment{card}
	default:
		var in struct {
			Text        string            `json:"text"`
			Attachments *[]api.Attachment `json:"attachments"`
		}
		if err := json.Unmarshal(payload, &in); err != nil {
			badRequest(w, r, `The body must be JSON like {"text": "..."}.`)
			return
		}
		body, attachments = in.Text, in.Attachments
	}
	clean, raw, problem := cleanAttachments(attachments)
	body = trimBody(body)
	if problem == "" && (body != "" || len(clean) == 0) {
		body, problem = validBody(body)
	}
	if problem != "" {
		badRequest(w, r, problem)
		return
	}

	c, err := h.Queries.GetChannel(r.Context(), hook.ChannelID)
	if err != nil {
		h.unavailable(w, r, "get channel", err)
		return
	}
	member, err := h.Queries.GetMemberRole(r.Context(), store.GetMemberRoleParams{ChannelID: c.ID, UserID: bot.ID})
	if err != nil {
		h.unavailable(w, r, "get membership", err)
		return
	}
	if member == "" || c.ArchivedAt.Valid {
		forbidden(w, r, CodeBotNotInChannel, "The bot is no longer a member of the channel, or it is archived.")
		return
	}
	// The channel's rules apply as for the bot's token: bots are members, so
	// announcement channels are read-only for them.
	role := access{ch: member, ws: WorkspaceMember}
	if !canPost(c, role) {
		forbidden(w, r, CodeReadOnlyChannel, "Only the workspace's owners and admins can send messages in this channel.")
		return
	}
	if c.Encrypted {
		forbidden(w, r, CodeEncrypted, "The channel is encrypted end to end: bots cannot write in it.")
		return
	}
	// Held to the rules of a message the bot sends with its token.
	v, ok := h.postingAllowed(w, r, c, role, bot, body, postOptions{slowMode: true})
	if !ok {
		return
	}
	err = h.inTx(r.Context(), func(q *store.Queries) error {
		out, err := postMessageTo(r.Context(), q, c, bot, body, "hook-"+randomNonce(), raw, replyTo{},
			postExtras{presence: h.Presence, noGroups: v.noGroups})
		if err != nil {
			return err
		}
		if err := flagMessage(r.Context(), q, c, out.Id, v.flags); err != nil {
			return err
		}
		return q.TouchWebhook(r.Context(), hook.ID)
	})
	if err != nil {
		h.unavailable(w, r, "post webhook message", err)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func randomNonce() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

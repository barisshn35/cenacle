// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	guuid "github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/auth"
	"github.com/barisshn35/cenacle/server/internal/egress"
	"github.com/barisshn35/cenacle/server/internal/events"
	"github.com/barisshn35/cenacle/server/internal/httpx"
	"github.com/barisshn35/cenacle/server/internal/integrations/signing"
	"github.com/barisshn35/cenacle/server/internal/policy"
	"github.com/barisshn35/cenacle/server/internal/store"
)

// Problem codes of slash commands.
const (
	CodeUnknownCommand = "unknown_command"
	CodeCommandFailed  = "command_failed"
)

// builtins are the commands Cenacle answers itself.
var builtins = []api.CommandInfo{
	{Trigger: "remind", Description: "Get a reminder from Cenacle", Hint: "me in 10m … | at 15:30 … | tomorrow …", Builtin: true},
	{Trigger: "join", Description: "Join a channel", Hint: "channel name", Builtin: true},
	{Trigger: "leave", Description: "Leave this channel", Builtin: true},
	{Trigger: "topic", Description: "Set the channel topic", Hint: "topic", Builtin: true},
	{Trigger: "me", Description: "Say something about yourself", Hint: "text", Builtin: true},
	{Trigger: "shrug", Description: `Add ¯\_(ツ)_/¯`, Hint: "text", Builtin: true},
	{Trigger: "feed", Description: "Follow a news feed (RSS, Atom) in this channel", Hint: "subscribe <address> | unsubscribe <address> | list", Builtin: true},
}

// ListCommands implements api.ServerInterface.
func (h *Handlers) ListCommands(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	if _, ok := h.workspaceRole(w, r, workspaceID, p.User); !ok {
		return
	}
	rows, err := h.Queries.ListWorkspaceCommands(r.Context(), pgUUID(workspaceID))
	if err != nil {
		h.unavailable(w, r, "list commands", err)
		return
	}
	out := append([]api.CommandInfo{}, builtins...)
	for _, c := range rows {
		out = append(out, api.CommandInfo{Trigger: c.Trigger, Description: c.Description, Hint: c.Hint})
	}
	httpx.WriteJSON(w, http.StatusOK, struct {
		Commands []api.CommandInfo `json:"commands"`
	}{out})
}

func ephemeral(w http.ResponseWriter, text string) {
	httpx.WriteJSON(w, http.StatusOK, api.CommandResult{ResponseType: api.CommandResultResponseTypeEphemeral, Text: &text})
}

// RunCommand implements api.ServerInterface.
func (h *Handlers) RunCommand(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in struct {
		Command  string  `json:"command"`
		Text     *string `json:"text"`
		Timezone *string `json:"timezone"`
	}
	if !decode(w, r, &in) {
		return
	}
	command := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(in.Command), "/"))
	text := ""
	if in.Text != nil {
		text = strings.TrimSpace(*in.Text)
	}
	c, role, ok := h.memberChannel(w, r, channelID, p.User)
	if !ok {
		return
	}
	// Commands post and call bots: they count like messages.
	if !h.allowMessage(w, r, p.User) {
		return
	}
	// In an encrypted channel the server must not get text to keep or pass
	// on (reminders, bots): only commands about the channel itself work.
	if c.Encrypted && command != "join" && command != "leave" && command != "topic" {
		ephemeral(w, "This channel is encrypted end to end: this command cannot be used in it.")
		return
	}
	switch command {
	case "remind":
		h.remind(w, r, p.User, c, text, in.Timezone)
	case "join":
		h.commandJoin(w, r, p.User, c, role, text)
	case "leave":
		if c.IsMandatory || isConversation(c) || c.GroupManaged {
			ephemeral(w, "You cannot leave this channel.")
			return
		}
		if _, err := h.Queries.RemoveMember(r.Context(), store.RemoveMemberParams{ChannelID: c.ID, UserID: p.User.ID}); err != nil {
			h.unavailable(w, r, "leave channel", err)
			return
		}
		h.membersChanged(r.Context(), c, p.User.ID, events.ChannelLeft, toAPI(c, access{}))
		httpx.WriteJSON(w, http.StatusOK, api.CommandResult{ResponseType: api.CommandResultResponseTypeNone})
	case "feed":
		h.commandFeed(w, r, p.User, c, role, text)
	case "topic":
		if !canManage(c, role) || c.ArchivedAt.Valid {
			ephemeral(w, "Only the channel's managers can change its topic.")
			return
		}
		topic, problem := cleanTopic(text)
		if problem != "" {
			ephemeral(w, problem)
			return
		}
		updated, err := h.Queries.UpdateChannel(r.Context(), store.UpdateChannelParams{
			ID: c.ID, Name: c.Name, Visibility: c.Visibility, Topic: topic, CategoryID: c.CategoryID,
			SlowModeSeconds: c.SlowModeSeconds, ForumTags: c.ForumTags, Moderation: c.Moderation,
		})
		if err != nil {
			h.unavailable(w, r, "set topic", err)
			return
		}
		h.publish(r.Context(), events.ChannelUpdated, ChannelEvent{Channel: toAPI(updated, access{ch: RoleMember}), ChannelID: uuid(c.ID).String()})
		httpx.WriteJSON(w, http.StatusOK, api.CommandResult{ResponseType: api.CommandResultResponseTypeNone})
	case "me", "shrug":
		body := "_" + strings.ReplaceAll(text, "_", `\_`) + "_"
		if command == "shrug" {
			body = strings.TrimSpace(text + ` ¯\\\_(ツ)\_/¯`)
		}
		if command == "me" && text == "" {
			ephemeral(w, "Usage: /me text")
			return
		}
		h.postOwnCommand(w, r, c, role, p.User, body)
	default:
		h.customCommand(w, r, p.User, c, role, command, text)
	}
}

// postOwnCommand posts what a command writes in its user's name (/me, /shrug),
// held to the same rules as a message they send.
func (h *Handlers) postOwnCommand(w http.ResponseWriter, r *http.Request, c store.Channel, role access, author store.User, body string) {
	if c.ArchivedAt.Valid || !canPost(c, role) {
		ephemeral(w, "You cannot send messages in this channel.")
		return
	}
	if c.Encrypted {
		ephemeral(w, "This channel is encrypted end to end: commands cannot write in it.")
		return
	}
	v, ok := h.postingAllowed(w, r, c, role, author, body, postOptions{slowMode: true})
	if !ok {
		return
	}
	var out api.Message
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		var err error
		out, err = postMessageTo(r.Context(), q, c, author, body, "cmd-"+randomNonce(), []byte("[]"), replyTo{},
			postExtras{presence: h.Presence, noGroups: v.noGroups})
		if err != nil {
			return err
		}
		return flagMessage(r.Context(), q, c, out.Id, v.flags)
	})
	if err != nil {
		h.unavailable(w, r, "post command message", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, api.CommandResult{ResponseType: api.CommandResultResponseTypeInChannel, Message: &out})
}

func (h *Handlers) commandJoin(w http.ResponseWriter, r *http.Request, user store.User, from store.Channel, role access, name string) {
	if name == "" {
		ephemeral(w, "Usage: /join channel name")
		return
	}
	c, err := h.Queries.GetChannelByName(r.Context(), store.GetChannelByNameParams{WorkspaceID: from.WorkspaceID, Name: strings.TrimPrefix(name, "#")})
	// Guests are only in the channels they were added to, as with JoinChannel.
	if isNoRows(err) || role.ws == WorkspaceGuest ||
		(err == nil && (c.Visibility == Private || isConversation(c) || c.ArchivedAt.Valid)) {
		ephemeral(w, fmt.Sprintf("No open public channel is named %q.", name))
		return
	}
	if err != nil {
		h.unavailable(w, r, "find channel", err)
		return
	}
	if c.GroupManaged {
		ephemeral(w, "Membership of this channel follows directory groups.")
		return
	}
	if ok, err := policy.Qualifies(r.Context(), h.Queries, c, user.ID); err != nil {
		h.unavailable(w, r, "get attributes", err)
		return
	} else if !ok {
		ephemeral(w, "This channel is for members with certain attributes (e.g. department).")
		return
	}
	n, err := h.Queries.AddMember(r.Context(), store.AddMemberParams{ChannelID: c.ID, UserID: user.ID, Role: RoleMember})
	if err != nil {
		h.unavailable(w, r, "join channel", err)
		return
	}
	if n > 0 {
		h.membersChanged(r.Context(), c, user.ID, events.ChannelJoined, toAPI(c, access{ch: RoleMember}))
		h.memberJoined(r.Context(), c, user)
	}
	ephemeral(w, fmt.Sprintf("You are in %s.", c.Name))
}

// systemBot returns the workspace's "Cenacle" bot, creating it on first use.
func (h *Handlers) systemBot(ctx context.Context, q *store.Queries, workspace pgtype.UUID) (store.User, error) {
	return systemBot(ctx, q, workspace)
}

func systemBot(ctx context.Context, q *store.Queries, workspace pgtype.UUID) (store.User, error) {
	row, err := q.GetSystemBot(ctx, workspace)
	if err == nil {
		return row.User, nil
	}
	if !isNoRows(err) {
		return store.User{}, err
	}
	id := guuid.Must(guuid.NewV7())
	u, err := q.CreateBotUser(ctx, store.CreateBotUserParams{AuthData: "system:" + id.String(), DisplayName: "Cenacle"})
	if err != nil {
		return store.User{}, err
	}
	if _, err := q.CreateSystemBot(ctx, store.CreateSystemBotParams{ID: pgUUID(id), WorkspaceID: workspace, UserID: u.ID}); err != nil {
		return store.User{}, err
	}
	if _, err := q.AddWorkspaceMember(ctx, store.AddWorkspaceMemberParams{WorkspaceID: workspace, UserID: u.ID, Role: WorkspaceMember}); err != nil {
		return store.User{}, err
	}
	// Another request may have created it meanwhile (the insert did nothing then).
	row, err = q.GetSystemBot(ctx, workspace)
	return row.User, err
}

// remind schedules a reminder sent by the system bot in a direct conversation.
func (h *Handlers) remind(w http.ResponseWriter, r *http.Request, user store.User, c store.Channel, text string, timezone *string) {
	loc := time.UTC
	if timezone != nil {
		if l, err := time.LoadLocation(*timezone); err == nil {
			loc = l
		}
	}
	when, what, ok := parseReminder(text, time.Now(), loc)
	if !ok {
		ephemeral(w, "Usage: /remind me in 10m <text>, /remind at 15:30 <text>, /remind tomorrow <text> (also: 10 dk sonra, yarın 9:00).")
		return
	}
	if len([]rune(what)) > 3000 {
		ephemeral(w, "The reminder text is too long.")
		return
	}
	if !h.belowScheduledLimit(w, r, user) {
		return
	}
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		_, err := h.scheduleReminder(r.Context(), q, c.WorkspaceID, user, "⏰ "+what, when)
		return err
	})
	if err != nil {
		h.unavailable(w, r, "schedule reminder", err)
		return
	}
	ephemeral(w, fmt.Sprintf("I will remind you %s: %s", when.In(loc).Format("Mon 2 Jan 15:04 (MST)"), what))
}

// commandRequest is what a bot's command server receives.
type commandRequest struct {
	Command     string `json:"command"`
	Text        string `json:"text"`
	UserID      string `json:"user_id"`
	UserName    string `json:"user_name"`
	ChannelID   string `json:"channel_id"`
	ChannelName string `json:"channel_name"`
	WorkspaceID string `json:"workspace_id"`
}

// commandResponse is what it may answer.
type commandResponse struct {
	ResponseType string            `json:"response_type"`
	Text         string            `json:"text"`
	Attachments  *[]api.Attachment `json:"attachments"`
	// Dialog opens a form for the caller (bots with an interactions address).
	Dialog *dialogSpec `json:"dialog"`
}

func (h *Handlers) customCommand(w http.ResponseWriter, r *http.Request, user store.User, c store.Channel, role access, trigger, text string) {
	// The bot acts on the caller's behalf: a timed-out member cannot use it.
	if h.timedOut(w, r, c.WorkspaceID, user) {
		return
	}
	row, err := h.Queries.GetWorkspaceCommand(r.Context(), store.GetWorkspaceCommandParams{WorkspaceID: c.WorkspaceID, Trigger: trigger})
	if isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: CodeUnknownCommand,
			Detail: "No command /" + trigger + " in this workspace."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "find command", err)
		return
	}
	if h.Egress == nil {
		h.unavailable(w, r, "run command", fmt.Errorf("no egress client"))
		return
	}
	body, _ := json.Marshal(commandRequest{
		Command: "/" + trigger, Text: text, UserID: uuid(user.ID).String(), UserName: user.DisplayName,
		ChannelID: uuid(c.ID).String(), ChannelName: c.Name, WorkspaceID: uuid(c.WorkspaceID).String(),
	})
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, row.SlashCommand.Url, bytes.NewReader(body))
	if err != nil {
		h.commandFailed(w, r, trigger, err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Cenacle")
	req.Header.Set(signing.Header, signing.Sign(row.SlashCommand.Secret, time.Now(), body))
	res, err := h.Egress.Do(req)
	if err != nil {
		h.commandFailed(w, r, trigger, err)
		return
	}
	if res.Status < 200 || res.Status > 299 {
		h.commandFailed(w, r, trigger, fmt.Errorf("status %d", res.Status))
		return
	}
	var out commandResponse
	if len(bytes.TrimSpace(res.Body)) == 0 {
		httpx.WriteJSON(w, http.StatusOK, api.CommandResult{ResponseType: api.CommandResultResponseTypeNone})
		return
	}
	if err := json.Unmarshal(res.Body, &out); err != nil {
		h.commandFailed(w, r, trigger, fmt.Errorf("answer is not JSON"))
		return
	}
	clean, raw, problem := cleanAttachments(out.Attachments)
	if problem != "" {
		h.commandFailed(w, r, trigger, fmt.Errorf("answer: %s", problem))
		return
	}
	if out.Dialog != nil {
		bot, err := h.Queries.GetInteractiveBot(r.Context(), row.User.ID)
		if err != nil {
			h.commandFailed(w, r, trigger, fmt.Errorf("a dialog needs the bot's interactions address"))
			return
		}
		d, err := h.openDialog(r.Context(), *out.Dialog, bot.ID, user, c, pgtype.UUID{})
		if err != nil {
			h.commandFailed(w, r, trigger, err)
			return
		}
		text := out.Text
		httpx.WriteJSON(w, http.StatusOK, api.CommandResult{ResponseType: api.CommandResultResponseTypeEphemeral, Text: &text, Dialog: &d})
		return
	}
	if out.ResponseType != "in_channel" {
		text := out.Text
		httpx.WriteJSON(w, http.StatusOK, api.CommandResult{ResponseType: api.CommandResultResponseTypeEphemeral, Text: &text, Attachments: &clean})
		return
	}
	msg := trimBody(out.Text)
	if msg == "" && len(clean) == 0 {
		httpx.WriteJSON(w, http.StatusOK, api.CommandResult{ResponseType: api.CommandResultResponseTypeNone})
		return
	}
	if msg != "" {
		if msg, problem = validBody(msg); problem != "" {
			h.commandFailed(w, r, trigger, fmt.Errorf("answer: %s", problem))
			return
		}
	}
	// Posted in the caller's channel, under the caller's rights, as the bot.
	if c.ArchivedAt.Valid || !canPost(c, role) {
		ephemeral(w, "You cannot send messages in this channel.")
		return
	}
	if c.Encrypted {
		ephemeral(w, "This channel is encrypted end to end: bots cannot write in it.")
		return
	}
	v, ok := h.postingAllowed(w, r, c, role, user, msg, postOptions{slowMode: true})
	if !ok {
		return
	}
	var posted api.Message
	err = h.inTx(r.Context(), func(q *store.Queries) error {
		var err error
		posted, err = postMessageTo(r.Context(), q, c, row.User, msg, "cmd-"+randomNonce(), raw, replyTo{},
			postExtras{presence: h.Presence, noGroups: v.noGroups})
		if err != nil {
			return err
		}
		return flagMessage(r.Context(), q, c, posted.Id, v.flags)
	})
	if err != nil {
		h.unavailable(w, r, "post command answer", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, api.CommandResult{ResponseType: api.CommandResultResponseTypeInChannel, Message: &posted})
}

func (h *Handlers) commandFailed(w http.ResponseWriter, r *http.Request, trigger string, err error) {
	h.Log.InfoContext(r.Context(), "slash command failed", "command", trigger, "error", err)
	detail := "The server of /" + trigger + " did not answer properly."
	if errors.Is(err, egress.ErrForbiddenAddress) {
		detail = "The address of /" + trigger + " is not allowed (an internal network); an administrator can allow it."
	}
	httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusBadGateway, Code: CodeCommandFailed, Detail: detail})
}

// errNotInWorkspace: the person is not a member of the workspace.
var errNotInWorkspace = errors.New("not a member of the workspace")

// botConversation returns a person's conversation with the workspace's system
// bot, created when needed; only for members of the workspace.
func botConversation(ctx context.Context, q *store.Queries, workspace pgtype.UUID, bot store.User, user pgtype.UUID) (store.Channel, error) {
	role, err := q.GetWorkspaceRole(ctx, store.GetWorkspaceRoleParams{WorkspaceID: workspace, UserID: user})
	if err != nil {
		return store.Channel{}, err
	}
	if role == "" {
		return store.Channel{}, errNotInWorkspace
	}
	kind, key := conversationKey([]string{uuid(user).String(), uuid(bot.ID).String()})
	dm, err := q.GetChannelByName(ctx, store.GetChannelByNameParams{WorkspaceID: workspace, Name: key})
	if isNoRows(err) {
		dm, err = q.CreateConversation(ctx, store.CreateConversationParams{
			WorkspaceID: workspace, Name: key, Kind: kind, CreatedBy: bot.ID,
		})
	}
	if err != nil {
		return dm, err
	}
	for _, id := range []pgtype.UUID{user, bot.ID} {
		n, err := q.AddMember(ctx, store.AddMemberParams{ChannelID: dm.ID, UserID: id, Role: RoleMember})
		if err != nil {
			return dm, err
		}
		if n > 0 && id == user {
			if err := emit(ctx, q, events.ChannelJoined, ChannelEvent{Channel: toAPI(dm, access{ch: RoleMember}), UserID: uuid(id).String()}); err != nil {
				return dm, err
			}
		}
	}
	return dm, nil
}

// scheduleReminder schedules a message from the workspace's system bot to a
// person, in their conversation with it (created when needed).
func (h *Handlers) scheduleReminder(ctx context.Context, q *store.Queries, workspace pgtype.UUID, user store.User, body string, when time.Time) (store.ScheduledMessage, error) {
	bot, err := h.systemBot(ctx, q, workspace)
	if err != nil {
		return store.ScheduledMessage{}, err
	}
	dm, err := botConversation(ctx, q, workspace, bot, user.ID)
	if err != nil {
		return store.ScheduledMessage{}, err
	}
	return q.CreateScheduledMessage(ctx, store.CreateScheduledMessageParams{
		Kind: "reminder", ChannelID: dm.ID, AuthorID: bot.ID, OwnerID: user.ID,
		Body: body, SendAt: when,
	})
}

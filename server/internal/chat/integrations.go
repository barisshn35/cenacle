// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/audit"
	"github.com/barisshn35/cenacle/server/internal/auth"
	"github.com/barisshn35/cenacle/server/internal/httpx"
	"github.com/barisshn35/cenacle/server/internal/integrations/signing"
	"github.com/barisshn35/cenacle/server/internal/store"
)

// CodeCommandTaken: another bot of the workspace has this command.
const CodeCommandTaken = "command_taken"

// SubscribableEvents are the events a bot can subscribe to.
var SubscribableEvents = []string{
	"message.created", "message.updated", "message.deleted", "reaction.added", "reaction.removed",
}

// MaxScheduleAhead bounds how far ahead a message can be scheduled.
const MaxScheduleAhead = 365 * 24 * time.Hour

// MaxPendingScheduled bounds what one person has scheduled (messages and reminders).
const MaxPendingScheduled = 200

// CodeTooManyScheduled: the person has scheduled as much as allowed.
const CodeTooManyScheduled = "too_many_scheduled"

func (h *Handlers) belowScheduledLimit(w http.ResponseWriter, r *http.Request, user store.User) bool {
	n, err := h.Queries.CountPendingScheduled(r.Context(), user.ID)
	if err != nil {
		h.unavailable(w, r, "count scheduled", err)
		return false
	}
	if n >= MaxPendingScheduled {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeTooManyScheduled,
			Detail: "You have 200 messages and reminders waiting; cancel some first."})
		return false
	}
	return true
}

func commandAPI(c store.SlashCommand) api.SlashCommand {
	return api.SlashCommand{Id: uuid(c.ID), Trigger: c.Trigger, Url: c.Url, Description: c.Description,
		Hint: c.Hint, CreatedAt: c.CreatedAt}
}

func subscriptionAPI(s store.EventSubscription) api.Subscription {
	return api.Subscription{Id: uuid(s.ID), Url: s.Url, Events: s.Events, Disabled: s.DisabledAt.Valid, CreatedAt: s.CreatedAt}
}

func deliveryAPI(d store.EventDelivery) api.Delivery {
	out := api.Delivery{Id: uuid(d.ID), EventType: d.EventType, Status: api.DeliveryStatus(d.Status),
		Attempts: int(d.Attempts), NextAttemptAt: d.NextAttemptAt, LastError: d.LastError,
		CreatedAt: d.CreatedAt, DeliveredAt: tsPtr(d.DeliveredAt)}
	if d.LastStatus.Valid {
		v := int(d.LastStatus.Int32)
		out.LastStatus = &v
	}
	return out
}

// cleanLine checks a short single-line text (descriptions, hints).
func cleanLine(s string, max int) (string, bool) {
	s = strings.TrimSpace(s)
	return s, utf8.RuneCountInString(s) <= max && !strings.ContainsFunc(s, unicode.IsControl)
}

// checkTarget validates a URL Cenacle will call.
func (h *Handlers) checkTarget(raw string) string {
	if h.Egress == nil {
		return "Outgoing requests are not configured on this server."
	}
	if len(raw) > 2000 {
		return "The address is too long."
	}
	if _, err := h.Egress.CheckURL(strings.TrimSpace(raw)); err != nil {
		return "The address must be an absolute https URL without credentials."
	}
	return ""
}

// ListBotCommands implements api.ServerInterface.
func (h *Handlers) ListBotCommands(w http.ResponseWriter, r *http.Request, botID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	b, ok := h.managedBot(w, r, botID, p.User)
	if !ok {
		return
	}
	rows, err := h.Queries.ListBotCommands(r.Context(), b.Bot.ID)
	if err != nil {
		h.unavailable(w, r, "list commands", err)
		return
	}
	out := make([]api.SlashCommand, 0, len(rows))
	for _, c := range rows {
		out = append(out, commandAPI(c))
	}
	httpx.WriteJSON(w, http.StatusOK, struct {
		Commands []api.SlashCommand `json:"commands"`
	}{out})
}

// CreateBotCommand implements api.ServerInterface.
func (h *Handlers) CreateBotCommand(w http.ResponseWriter, r *http.Request, botID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in struct {
		Trigger     string  `json:"trigger"`
		URL         string  `json:"url"`
		Description *string `json:"description"`
		Hint        *string `json:"hint"`
	}
	if !decode(w, r, &in) {
		return
	}
	b, ok := h.managedBot(w, r, botID, p.User)
	if !ok {
		return
	}
	trigger := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(in.Trigger), "/"))
	problem := ""
	if !validTrigger(trigger) {
		problem = "A command is 1–32 lowercase letters, digits, - or _."
	} else if slices.ContainsFunc(builtins, func(c api.CommandInfo) bool { return c.Trigger == trigger }) {
		problem = "/" + trigger + " is a built-in command."
	}
	if problem == "" {
		problem = h.checkTarget(in.URL)
	}
	var description, hint string
	if problem == "" && in.Description != nil {
		if description, ok = cleanLine(*in.Description, 200); !ok {
			problem = "The description is longer than 200 characters or contains invalid characters."
		}
	}
	if problem == "" && in.Hint != nil {
		if hint, ok = cleanLine(*in.Hint, 100); !ok {
			problem = "The hint is longer than 100 characters or contains invalid characters."
		}
	}
	if problem != "" {
		badRequest(w, r, problem)
		return
	}
	secret := signing.NewSecret()
	c, err := h.Queries.CreateSlashCommand(r.Context(), store.CreateSlashCommandParams{
		BotID: b.Bot.ID, WorkspaceID: b.Bot.WorkspaceID, Trigger: trigger, Url: strings.TrimSpace(in.URL),
		Description: description, Hint: hint, Secret: secret, CreatedBy: p.User.ID,
	})
	if isUniqueViolation(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeCommandTaken,
			Detail: "/" + trigger + " already exists in this workspace."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "create command", err)
		return
	}
	h.record(r, b.Bot.WorkspaceID, audit.CommandCreated, "bot", botID.String(),
		map[string]any{"bot": b.DisplayName, "command": trigger})
	httpx.WriteJSON(w, http.StatusCreated, struct {
		Command api.SlashCommand `json:"command"`
		Secret  string           `json:"secret"`
	}{commandAPI(c), secret})
}

func validTrigger(s string) bool {
	if s == "" || len(s) > 32 {
		return false
	}
	for i, c := range s {
		ok := c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || i > 0 && (c == '-' || c == '_')
		if !ok {
			return false
		}
	}
	return true
}

// DeleteBotCommand implements api.ServerInterface.
func (h *Handlers) DeleteBotCommand(w http.ResponseWriter, r *http.Request, botID, commandID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	b, ok := h.managedBot(w, r, botID, p.User)
	if !ok {
		return
	}
	n, err := h.Queries.DeleteSlashCommand(r.Context(), store.DeleteSlashCommandParams{ID: pgUUID(commandID), BotID: b.Bot.ID})
	if err != nil {
		h.unavailable(w, r, "delete command", err)
		return
	}
	if n == 0 {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No command with this id."})
		return
	}
	h.record(r, b.Bot.WorkspaceID, audit.CommandDeleted, "bot", botID.String(),
		map[string]any{"bot": b.DisplayName, "command_id": commandID.String()})
	w.WriteHeader(http.StatusNoContent)
}

// ListSubscriptions implements api.ServerInterface.
func (h *Handlers) ListSubscriptions(w http.ResponseWriter, r *http.Request, botID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	b, ok := h.managedBot(w, r, botID, p.User)
	if !ok {
		return
	}
	rows, err := h.Queries.ListSubscriptions(r.Context(), b.Bot.ID)
	if err != nil {
		h.unavailable(w, r, "list subscriptions", err)
		return
	}
	out := make([]api.Subscription, 0, len(rows))
	for _, s := range rows {
		out = append(out, subscriptionAPI(s))
	}
	httpx.WriteJSON(w, http.StatusOK, struct {
		Subscriptions []api.Subscription `json:"subscriptions"`
	}{out})
}

// CreateSubscription implements api.ServerInterface.
func (h *Handlers) CreateSubscription(w http.ResponseWriter, r *http.Request, botID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in struct {
		URL    string   `json:"url"`
		Events []string `json:"events"`
	}
	if !decode(w, r, &in) {
		return
	}
	b, ok := h.managedBot(w, r, botID, p.User)
	if !ok {
		return
	}
	problem := h.checkTarget(in.URL)
	events := []string{}
	for _, e := range in.Events {
		if !slices.Contains(SubscribableEvents, e) {
			problem = "Events are " + strings.Join(SubscribableEvents, ", ") + "."
		} else if !slices.Contains(events, e) {
			events = append(events, e)
		}
	}
	if problem == "" && len(events) == 0 {
		problem = "Choose at least one event."
	}
	if problem != "" {
		badRequest(w, r, problem)
		return
	}
	secret := signing.NewSecret()
	s, err := h.Queries.CreateSubscription(r.Context(), store.CreateSubscriptionParams{
		BotID: b.Bot.ID, Url: strings.TrimSpace(in.URL), Events: events, Secret: secret, CreatedBy: p.User.ID,
	})
	if err != nil {
		h.unavailable(w, r, "create subscription", err)
		return
	}
	h.record(r, b.Bot.WorkspaceID, audit.SubscribedTo, "bot", botID.String(),
		map[string]any{"bot": b.DisplayName, "url": s.Url, "events": events})
	httpx.WriteJSON(w, http.StatusCreated, struct {
		Subscription api.Subscription `json:"subscription"`
		Secret       string           `json:"secret"`
	}{subscriptionAPI(s), secret})
}

// DeleteSubscription implements api.ServerInterface.
func (h *Handlers) DeleteSubscription(w http.ResponseWriter, r *http.Request, botID, subscriptionID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	b, ok := h.managedBot(w, r, botID, p.User)
	if !ok {
		return
	}
	n, err := h.Queries.DeleteSubscription(r.Context(), store.DeleteSubscriptionParams{ID: pgUUID(subscriptionID), BotID: b.Bot.ID})
	if err != nil {
		h.unavailable(w, r, "delete subscription", err)
		return
	}
	if n == 0 {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No subscription with this id."})
		return
	}
	h.record(r, b.Bot.WorkspaceID, audit.Unsubscribed, "bot", botID.String(),
		map[string]any{"bot": b.DisplayName, "subscription_id": subscriptionID.String()})
	w.WriteHeader(http.StatusNoContent)
}

// deliveriesPage is the size of a page of the delivery log.
const deliveriesPage = 50

// ListDeliveries implements api.ServerInterface.
func (h *Handlers) ListDeliveries(w http.ResponseWriter, r *http.Request, botID, subscriptionID openapi_types.UUID, params api.ListDeliveriesParams) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	b, ok := h.managedBot(w, r, botID, p.User)
	if !ok {
		return
	}
	subs, err := h.Queries.ListSubscriptions(r.Context(), b.Bot.ID)
	if err != nil {
		h.unavailable(w, r, "list subscriptions", err)
		return
	}
	if !slices.ContainsFunc(subs, func(s store.EventSubscription) bool { return s.ID == pgUUID(subscriptionID) }) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No subscription with this id."})
		return
	}
	var before pgtype.UUID
	if params.Before != nil {
		before = pgUUID(*params.Before)
	}
	rows, err := h.Queries.ListDeliveries(r.Context(), store.ListDeliveriesParams{
		SubscriptionID: pgUUID(subscriptionID), Before: before, RowLimit: deliveriesPage + 1,
	})
	if err != nil {
		h.unavailable(w, r, "list deliveries", err)
		return
	}
	more := len(rows) > deliveriesPage
	rows = rows[:min(len(rows), deliveriesPage)]
	out := make([]api.Delivery, 0, len(rows))
	for _, d := range rows {
		out = append(out, deliveryAPI(d))
	}
	httpx.WriteJSON(w, http.StatusOK, struct {
		Deliveries []api.Delivery `json:"deliveries"`
		HasMore    bool           `json:"has_more"`
	}{out, more})
}

// ResendDelivery implements api.ServerInterface.
func (h *Handlers) ResendDelivery(w http.ResponseWriter, r *http.Request, botID, deliveryID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	b, ok := h.managedBot(w, r, botID, p.User)
	if !ok {
		return
	}
	_, err := h.Queries.ResendDelivery(r.Context(), store.ResendDeliveryParams{ID: pgUUID(deliveryID), BotID: b.Bot.ID})
	if isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No delivery with this id."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "resend delivery", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// RotateBotToken implements api.ServerInterface.
func (h *Handlers) RotateBotToken(w http.ResponseWriter, r *http.Request, botID, tokenID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in struct {
		OverlapHours int `json:"overlap_hours"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.OverlapHours < 0 || in.OverlapHours > 168 {
		badRequest(w, r, "overlap_hours must be between 0 and 168.")
		return
	}
	b, ok := h.managedBot(w, r, botID, p.User)
	if !ok {
		return
	}
	secret, hash := auth.NewBotToken()
	var created store.BotToken
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		old, err := q.GetBotToken(r.Context(), store.GetBotTokenParams{ID: pgUUID(tokenID), BotID: b.Bot.ID})
		if err != nil {
			return err
		}
		// The new token gets the lifetime the old one was given.
		var expires pgtype.Timestamptz
		if old.ExpiresAt.Valid {
			expires = pgtype.Timestamptz{Time: time.Now().Add(old.ExpiresAt.Time.Sub(old.CreatedAt)), Valid: true}
		}
		created, err = q.CreateBotToken(r.Context(), store.CreateBotTokenParams{
			BotID: b.Bot.ID, Name: old.Name, TokenHash: hash, Scopes: old.Scopes, CreatedBy: p.User.ID, ExpiresAt: expires,
		})
		if err != nil {
			return err
		}
		if in.OverlapHours == 0 {
			_, err = q.RevokeBotToken(r.Context(), store.RevokeBotTokenParams{ID: old.ID, BotID: b.Bot.ID})
			return err
		}
		_, err = q.ExpireBotToken(r.Context(), store.ExpireBotTokenParams{
			ID: old.ID, BotID: b.Bot.ID, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Duration(in.OverlapHours) * time.Hour), Valid: true},
		})
		return err
	})
	if isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No active token with this id."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "rotate token", err)
		return
	}
	h.record(r, b.Bot.WorkspaceID, audit.BotTokenRotated, "bot", botID.String(),
		map[string]any{"bot": b.DisplayName, "token": created.Name, "old_token_id": tokenID.String(), "overlap_hours": in.OverlapHours})
	httpx.WriteJSON(w, http.StatusCreated, struct {
		Token  api.BotToken `json:"token"`
		Secret string       `json:"secret"`
	}{tokenAPI(created), secret})
}

func scheduledAPI(s store.ScheduledMessage, channelName string, workspace pgtype.UUID) api.ScheduledMessage {
	return api.ScheduledMessage{Id: uuid(s.ID), Kind: api.ScheduledMessageKind(s.Kind), ChannelId: uuid(s.ChannelID),
		ChannelName: channelName, WorkspaceId: uuid(workspace), Body: s.Body, SendAt: s.SendAt}
}

// ScheduleMessage implements api.ServerInterface.
func (h *Handlers) ScheduleMessage(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in struct {
		Body   string    `json:"body"`
		SendAt time.Time `json:"send_at"`
	}
	if !decode(w, r, &in) {
		return
	}
	body, problem := strings.TrimSpace(in.Body), ""
	if !strings.HasPrefix(body, "e2e:v1:") { // envelopes are checked with their channel
		body, problem = validBody(in.Body)
	}
	now := time.Now()
	switch {
	case problem != "":
	case !in.SendAt.After(now.Add(30 * time.Second)):
		problem = "Pick a time at least a minute from now."
	case in.SendAt.After(now.Add(MaxScheduleAhead)):
		problem = "Messages can be scheduled up to a year ahead."
	}
	if problem != "" {
		badRequest(w, r, problem)
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
	if !encryptedBody(c, body) || body == "" {
		refuseEncrypted(w, r)
		return
	}
	if !h.belowScheduledLimit(w, r, p.User) {
		return
	}
	s, err := h.Queries.CreateScheduledMessage(r.Context(), store.CreateScheduledMessageParams{
		Kind: "message", ChannelID: c.ID, AuthorID: p.User.ID, OwnerID: p.User.ID, Body: body, SendAt: in.SendAt,
	})
	if err != nil {
		h.unavailable(w, r, "schedule message", err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, scheduledAPI(s, c.Name, c.WorkspaceID))
}

// ListScheduled implements api.ServerInterface.
func (h *Handlers) ListScheduled(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	rows, err := h.Queries.ListScheduledMessages(r.Context(), p.User.ID)
	if err != nil {
		h.unavailable(w, r, "list scheduled", err)
		return
	}
	out := make([]api.ScheduledMessage, 0, len(rows))
	for _, s := range rows {
		out = append(out, scheduledAPI(store.ScheduledMessage{ID: s.ID, Kind: s.Kind, ChannelID: s.ChannelID,
			Body: s.Body, SendAt: s.SendAt}, s.ChannelName, s.WorkspaceID))
	}
	httpx.WriteJSON(w, http.StatusOK, struct {
		Scheduled []api.ScheduledMessage `json:"scheduled"`
	}{out})
}

// CancelScheduled implements api.ServerInterface.
func (h *Handlers) CancelScheduled(w http.ResponseWriter, r *http.Request, scheduledID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	n, err := h.Queries.CancelScheduledMessage(r.Context(), store.CancelScheduledMessageParams{ID: pgUUID(scheduledID), OwnerID: p.User.ID})
	if err != nil {
		h.unavailable(w, r, "cancel scheduled", err)
		return
	}
	if n == 0 {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "Nothing scheduled with this id, or it was already sent."})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

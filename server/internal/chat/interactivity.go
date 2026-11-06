// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
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
	"github.com/Cenacle-TR/cenacle/server/internal/integrations/signing"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

// Problem codes of interactions.
const (
	CodeNoInteractions = "no_interactions"
	CodeBotFailed      = "bot_failed"
)

// Limits of actions and dialogs.
const (
	MaxActions        = 5
	MaxActionOptions  = 25
	MaxDialogElements = 10
	MaxDialogOptions  = 100
)

var nameRE = regexp.MustCompile(`^[a-z0-9_-]{1,64}$`)
var dateRE = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// cleanActions checks the buttons and menus of a card.
func cleanActions(in []api.AttachmentAction) ([]api.AttachmentAction, string) {
	if len(in) > MaxActions {
		return nil, "A card has up to 5 buttons and menus."
	}
	out := make([]api.AttachmentAction, 0, len(in))
	seen := map[string]bool{}
	for _, a := range in {
		if !nameRE.MatchString(a.Id) || seen[a.Id] {
			return nil, "Each button or menu needs its own id: 1–64 lowercase letters, digits, - or _."
		}
		seen[a.Id] = true
		text, ok := cleanText(a.Text, 80, false)
		if !ok || text == "" {
			return nil, "A button's label or a menu's placeholder has 1 to 80 characters."
		}
		c := api.AttachmentAction{Id: a.Id, Type: a.Type, Text: text}
		if a.Style != nil {
			if !a.Style.Valid() {
				return nil, "style is default, primary or danger."
			}
			c.Style = a.Style
		}
		switch a.Type {
		case api.AttachmentActionTypeButton:
			if a.Value != nil {
				v, ok := cleanText(*a.Value, 200, false)
				if !ok {
					return nil, "A button's value has up to 200 characters."
				}
				c.Value = &v
			}
		case api.AttachmentActionTypeSelect:
			opts, problem := cleanOptions(a.Options, MaxActionOptions)
			if problem != "" {
				return nil, problem
			}
			c.Options = &opts
		default:
			return nil, "An action is a button or a select."
		}
		out = append(out, c)
	}
	return out, ""
}

func cleanOptions(in *[]api.ActionOption, max int) ([]api.ActionOption, string) {
	if in == nil || len(*in) == 0 || len(*in) > max {
		return nil, fmt.Sprintf("A menu has 1 to %d options.", max)
	}
	out := make([]api.ActionOption, 0, len(*in))
	for _, o := range *in {
		t, ok1 := cleanText(o.Text, 80, false)
		v, ok2 := cleanText(o.Value, 200, false)
		if !ok1 || !ok2 || t == "" || v == "" {
			return nil, "An option needs a text (up to 80 characters) and a value (up to 200)."
		}
		out = append(out, api.ActionOption{Text: t, Value: v})
	}
	return out, ""
}

// dialogSpec is a dialog as a bot asks for it.
type dialogSpec struct {
	Title       string              `json:"title"`
	SubmitLabel string              `json:"submit_label"`
	Elements    []api.DialogElement `json:"elements"`
	State       string              `json:"state"`
}

// botAnswer is what a bot answers to an interaction.
type botAnswer struct {
	Text   string `json:"text"`
	Update *struct {
		Text        *string           `json:"text"`
		Attachments *[]api.Attachment `json:"attachments"`
	} `json:"update"`
	Dialog *dialogSpec       `json:"dialog"`
	Errors map[string]string `json:"errors"`
}

// cleanDialog checks a dialog a bot asks to open.
func cleanDialog(d dialogSpec) (dialogSpec, string) {
	title, ok := cleanText(d.Title, 100, false)
	if !ok || title == "" {
		return d, "A dialog's title has 1 to 100 characters."
	}
	submit := "Submit"
	if d.SubmitLabel != "" {
		if submit, ok = cleanText(d.SubmitLabel, 30, false); !ok || submit == "" {
			return d, "A dialog's submit label has up to 30 characters."
		}
	}
	if len(d.Elements) == 0 || len(d.Elements) > MaxDialogElements {
		return d, "A dialog has 1 to 10 fields."
	}
	if utf8.RuneCountInString(d.State) > 3000 {
		return d, "A dialog's state has up to 3,000 characters."
	}
	seen := map[string]bool{}
	elements := make([]api.DialogElement, 0, len(d.Elements))
	for _, e := range d.Elements {
		if !nameRE.MatchString(e.Name) || seen[e.Name] {
			return d, "Each field needs its own name: 1–64 lowercase letters, digits, - or _."
		}
		seen[e.Name] = true
		label, ok := cleanText(e.Label, 100, false)
		if !ok || label == "" {
			return d, "A field's label has 1 to 100 characters."
		}
		c := api.DialogElement{Name: e.Name, Label: label, Type: e.Type, Optional: e.Optional, MaxLength: e.MaxLength}
		for _, f := range []struct {
			in  *string
			out **string
			max int
		}{{e.Placeholder, &c.Placeholder, 150}, {e.Help, &c.Help, 300}, {e.Value, &c.Value, 3000}} {
			if f.in != nil {
				v, ok := cleanText(*f.in, f.max, true)
				if !ok {
					return d, "A field's placeholder, help or value is too long."
				}
				*f.out = &v
			}
		}
		switch e.Type {
		case api.DialogElementTypeText, api.DialogElementTypeTextarea, api.DialogElementTypeCheckbox, api.DialogElementTypeDate:
		case api.DialogElementTypeSelect:
			opts, problem := cleanOptions(e.Options, MaxDialogOptions)
			if problem != "" {
				return d, problem
			}
			c.Options = &opts
		default:
			return d, "A field is text, textarea, select, checkbox or date."
		}
		elements = append(elements, c)
	}
	return dialogSpec{Title: title, SubmitLabel: submit, Elements: elements, State: d.State}, ""
}

// checkValues checks a dialog's submitted values against its fields; it
// returns the values to send and the fields that are wrong.
func checkValues(spec dialogSpec, in map[string]string) (map[string]any, map[string]string) {
	out := map[string]any{}
	wrong := map[string]string{}
	for _, e := range spec.Elements {
		v := strings.TrimSpace(in[e.Name])
		optional := e.Optional != nil && *e.Optional
		if e.Type == api.DialogElementTypeCheckbox {
			out[e.Name] = v == "true"
			continue
		}
		if v == "" {
			if !optional {
				wrong[e.Name] = "Required."
			}
			out[e.Name] = ""
			continue
		}
		max := 3000
		if e.Type == api.DialogElementTypeText {
			max = 150
		}
		if e.MaxLength != nil && *e.MaxLength < max {
			max = *e.MaxLength
		}
		switch {
		case utf8.RuneCountInString(v) > max:
			wrong[e.Name] = fmt.Sprintf("Up to %d characters.", max)
		case e.Type == api.DialogElementTypeDate && !dateRE.MatchString(v):
			wrong[e.Name] = "A date (YYYY-MM-DD)."
		case e.Type == api.DialogElementTypeSelect && !hasOption(e.Options, v):
			wrong[e.Name] = "Not one of the choices."
		}
		out[e.Name] = v
	}
	return out, wrong
}

func hasOption(opts *[]api.ActionOption, v string) bool {
	if opts == nil {
		return false
	}
	for _, o := range *opts {
		if o.Value == v {
			return true
		}
	}
	return false
}

// errBot is a bot that did not answer as it should.
var errBot = errors.New("the bot did not answer")

// callBot sends a signed interaction to a bot and reads its answer.
func (h *Handlers) callBot(ctx context.Context, url, secret string, payload any) (botAnswer, error) {
	var out botAnswer
	if h.Egress == nil {
		return out, fmt.Errorf("%w: no egress client", errBot)
	}
	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return out, fmt.Errorf("%w: %w", errBot, err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Cenacle")
	req.Header.Set(signing.Header, signing.Sign(secret, time.Now(), body))
	res, err := h.Egress.Do(req)
	if err != nil {
		return out, fmt.Errorf("%w: %w", errBot, err)
	}
	if res.Status < 200 || res.Status > 299 {
		return out, fmt.Errorf("%w: status %d", errBot, res.Status)
	}
	if len(bytes.TrimSpace(res.Body)) == 0 {
		return out, nil
	}
	if err := json.Unmarshal(res.Body, &out); err != nil {
		return out, fmt.Errorf("%w: the answer is not JSON", errBot)
	}
	return out, nil
}

func (h *Handlers) botFailed(w http.ResponseWriter, r *http.Request, err error) {
	h.Log.WarnContext(r.Context(), "interaction", "error", err)
	httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusBadGateway, Code: CodeBotFailed,
		Detail: "The app did not answer. Try again later."})
}

type interactionUser struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type interactionChannel struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// actionRequest is what a bot receives when a button is pressed or a menu used.
type actionRequest struct {
	Type        string             `json:"type"`
	ActionID    string             `json:"action_id"`
	Value       string             `json:"value"`
	MessageID   string             `json:"message_id"`
	Attachment  int                `json:"attachment"`
	User        interactionUser    `json:"user"`
	Channel     interactionChannel `json:"channel"`
	WorkspaceID string             `json:"workspace_id"`
}

// dialogRequest is what a bot receives when its dialog is submitted.
type dialogRequest struct {
	Type        string             `json:"type"`
	DialogID    string             `json:"dialog_id"`
	Values      map[string]any     `json:"values"`
	State       string             `json:"state"`
	MessageID   string             `json:"message_id,omitempty"`
	User        interactionUser    `json:"user"`
	Channel     interactionChannel `json:"channel"`
	WorkspaceID string             `json:"workspace_id"`
}

// SetBotInteractions implements api.ServerInterface.
func (h *Handlers) SetBotInteractions(w http.ResponseWriter, r *http.Request, botID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.SetBotInteractionsJSONBody
	if !decode(w, r, &in) {
		return
	}
	b, ok := h.managedBot(w, r, botID, p.User)
	if !ok {
		return
	}
	if problem := h.checkTarget(in.Url); problem != "" {
		badRequest(w, r, problem)
		return
	}
	secret := signing.NewSecret()
	if err := h.Queries.SetBotInteractions(r.Context(), store.SetBotInteractionsParams{
		ID: b.Bot.ID, Url: pgtype.Text{String: strings.TrimSpace(in.Url), Valid: true}, Secret: pgtype.Text{String: secret, Valid: true},
	}); err != nil {
		h.unavailable(w, r, "set interactions", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, struct {
		Secret string `json:"secret"`
	}{secret})
}

// DeleteBotInteractions implements api.ServerInterface.
func (h *Handlers) DeleteBotInteractions(w http.ResponseWriter, r *http.Request, botID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	b, ok := h.managedBot(w, r, botID, p.User)
	if !ok {
		return
	}
	if err := h.Queries.SetBotInteractions(r.Context(), store.SetBotInteractionsParams{ID: b.Bot.ID}); err != nil {
		h.unavailable(w, r, "delete interactions", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// RunMessageAction implements api.ServerInterface.
func (h *Handlers) RunMessageAction(w http.ResponseWriter, r *http.Request, channelID, messageID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.RunMessageActionJSONBody
	if !decode(w, r, &in) {
		return
	}
	c, _, m, ok := h.message(w, r, channelID, messageID, p.User)
	if !ok {
		return
	}
	notFound := func() {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No such button or menu."})
	}
	if m.DeletedAt.Valid || c.ArchivedAt.Valid {
		notFound()
		return
	}
	// The bot acts on the caller's behalf: a timed-out member cannot use it.
	if h.timedOut(w, r, c.WorkspaceID, p.User) {
		return
	}
	var cards []api.Attachment
	_ = json.Unmarshal(m.Attachments, &cards)
	if in.Attachment < 0 || in.Attachment >= len(cards) || cards[in.Attachment].Actions == nil {
		notFound()
		return
	}
	var action *api.AttachmentAction
	for i, a := range *cards[in.Attachment].Actions {
		if a.Id == in.ActionId {
			action = &(*cards[in.Attachment].Actions)[i]
		}
	}
	if action == nil {
		notFound()
		return
	}
	value := ""
	switch action.Type {
	case api.AttachmentActionTypeButton:
		if action.Value != nil {
			value = *action.Value
		}
	case api.AttachmentActionTypeSelect:
		if in.Value == nil || !hasOption(action.Options, *in.Value) {
			badRequest(w, r, "Choose one of the menu's options.")
			return
		}
		value = *in.Value
	}
	bot, err := h.Queries.GetInteractiveBot(r.Context(), m.AuthorID)
	if isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: CodeNoInteractions,
			Detail: "The app behind this message takes no interactions now."})
		return
	} else if err != nil {
		h.unavailable(w, r, "get bot", err)
		return
	}
	answer, err := h.callBot(r.Context(), bot.Url, bot.Secret, actionRequest{
		Type: "action", ActionID: action.Id, Value: value, MessageID: uuid(m.ID).String(), Attachment: in.Attachment,
		User:        interactionUser{ID: uuid(p.User.ID).String(), Name: p.User.DisplayName},
		Channel:     interactionChannel{ID: uuid(c.ID).String(), Name: c.Name},
		WorkspaceID: uuid(c.WorkspaceID).String(),
	})
	if err != nil {
		h.botFailed(w, r, err)
		return
	}
	h.answerInteraction(w, r, answer, bot.ID, p.User, c, m.ID)
}

// answerInteraction applies a bot's answer: it changes the message, opens a
// dialog, or tells the person something.
func (h *Handlers) answerInteraction(w http.ResponseWriter, r *http.Request, answer botAnswer, botID pgtype.UUID, user store.User, c store.Channel, message pgtype.UUID) {
	ctx := r.Context()
	out := api.InteractionResult{}
	if answer.Text != "" {
		text, ok := cleanText(answer.Text, 2000, true)
		if !ok {
			h.botFailed(w, r, fmt.Errorf("%w: the text is too long", errBot))
			return
		}
		out.Text = &text
	}
	if answer.Update != nil && message.Valid {
		if err := h.updateByBot(ctx, c, message, answer.Update.Text, answer.Update.Attachments); err != nil {
			if errors.Is(err, errBot) {
				h.botFailed(w, r, err)
			} else {
				h.unavailable(w, r, "update message", err)
			}
			return
		}
	}
	if answer.Dialog != nil {
		d, err := h.openDialog(ctx, *answer.Dialog, botID, user, c, message)
		if err != nil {
			h.botFailed(w, r, err)
			return
		}
		out.Dialog = &d
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// updateByBot replaces a bot message's text and cards (those not given stay).
func (h *Handlers) updateByBot(ctx context.Context, c store.Channel, id pgtype.UUID, text *string, cards *[]api.Attachment) error {
	return h.inTx(ctx, func(q *store.Queries) error {
		m, err := q.GetMessage(ctx, store.GetMessageParams{ID: id, ChannelID: c.ID})
		if err != nil {
			return err
		}
		body, raw := m.Body, m.Attachments
		if text != nil {
			b := trimBody(*text)
			if b != "" {
				var problem string
				if b, problem = validBody(b); problem != "" {
					return fmt.Errorf("%w: %s", errBot, problem)
				}
			}
			body = b
		}
		if cards != nil {
			_, clean, problem := cleanAttachments(cards)
			if problem != "" {
				return fmt.Errorf("%w: %s", errBot, problem)
			}
			raw = clean
		}
		// New text from the bot is held to AutoMod like the bot's messages.
		var flags []string
		if body != m.Body && !c.Encrypted {
			var no *postRefusal
			if flags, no, err = automodRules(ctx, q, c, access{ch: RoleMember, ws: WorkspaceMember}, body); err != nil {
				return err
			}
			if no != nil {
				return fmt.Errorf("%w: %s", errBot, no.detail)
			}
		}
		updated, err := q.UpdateMessageByBot(ctx, store.UpdateMessageByBotParams{ID: id, Body: body, Attachments: raw})
		if err != nil {
			return err
		}
		msgs := []api.Message{messageAPI(updated, m.AuthorName, m.AuthorIsBot)}
		if err := decorate(ctx, q, m.AuthorID, msgs); err != nil {
			return err
		}
		if err := flagMessage(ctx, q, c, msgs[0].Id, flags); err != nil {
			return err
		}
		return emit(ctx, q, events.MessageUpdated, msgs[0])
	})
}

// openDialog keeps a dialog a bot asked for and returns it for the person.
func (h *Handlers) openDialog(ctx context.Context, spec dialogSpec, botID pgtype.UUID, user store.User, c store.Channel, message pgtype.UUID) (api.Dialog, error) {
	clean, problem := cleanDialog(spec)
	if problem != "" {
		return api.Dialog{}, fmt.Errorf("%w: %s", errBot, problem)
	}
	raw, _ := json.Marshal(clean)
	id, err := h.Queries.CreateDialog(ctx, store.CreateDialogParams{
		BotID: botID, UserID: user.ID, ChannelID: c.ID, MessageID: message, Spec: raw,
	})
	if err != nil {
		return api.Dialog{}, err
	}
	return api.Dialog{Id: uuid(id), Title: clean.Title, SubmitLabel: clean.SubmitLabel, Elements: clean.Elements}, nil
}

// SubmitDialog implements api.ServerInterface.
func (h *Handlers) SubmitDialog(w http.ResponseWriter, r *http.Request, dialogID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.SubmitDialogJSONBody
	if !decode(w, r, &in) {
		return
	}
	ctx := r.Context()
	d, err := h.Queries.GetDialog(ctx, store.GetDialogParams{ID: pgUUID(dialogID), UserID: p.User.ID})
	if isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound,
			Detail: "The dialog is gone (it expires after 15 minutes)."})
		return
	} else if err != nil {
		h.unavailable(w, r, "get dialog", err)
		return
	}
	c, _, ok := h.memberChannel(w, r, uuid(d.ChannelID), p.User)
	if !ok || h.timedOut(w, r, c.WorkspaceID, p.User) {
		return
	}
	var spec dialogSpec
	_ = json.Unmarshal(d.Spec, &spec)
	values, wrong := checkValues(spec, in.Values)
	if len(wrong) > 0 {
		httpx.WriteJSON(w, http.StatusOK, api.InteractionResult{Errors: &wrong})
		return
	}
	req := dialogRequest{
		Type: "dialog_submission", DialogID: dialogID.String(), Values: values, State: spec.State,
		User:        interactionUser{ID: uuid(p.User.ID).String(), Name: p.User.DisplayName},
		Channel:     interactionChannel{ID: uuid(c.ID).String(), Name: c.Name},
		WorkspaceID: uuid(c.WorkspaceID).String(),
	}
	if d.MessageID.Valid {
		req.MessageID = uuid(d.MessageID).String()
	}
	answer, err := h.callBot(ctx, d.Url, d.Secret, req)
	if err != nil {
		h.botFailed(w, r, err)
		return
	}
	if len(answer.Errors) > 0 {
		errs := map[string]string{}
		for name, msg := range answer.Errors {
			if m, ok := cleanText(msg, 300, false); ok && nameRE.MatchString(name) {
				errs[name] = m
			}
		}
		httpx.WriteJSON(w, http.StatusOK, api.InteractionResult{Errors: &errs})
		return
	}
	if err := h.Queries.DeleteDialog(ctx, d.ID); err != nil {
		h.unavailable(w, r, "close dialog", err)
		return
	}
	h.answerInteraction(w, r, answer, d.BotID, p.User, c, d.MessageID)
}

// SPDX-License-Identifier: Apache-2.0

// Package cenacle is the Go SDK for Cenacle bots: a client for the API (with a
// bot token) and handlers for what Cenacle sends to bots — slash commands,
// interactions (buttons, menus, dialogs) and event subscriptions — with the
// signature checked.
package cenacle

// Attachment is a card under a message.
type Attachment struct {
	Title     string   `json:"title,omitempty"`
	TitleLink string   `json:"title_link,omitempty"`
	Text      string   `json:"text,omitempty"`
	Color     string   `json:"color,omitempty"` // neutral, info, success, warning, danger
	Fields    []Field  `json:"fields,omitempty"`
	Footer    string   `json:"footer,omitempty"`
	Actions   []Action `json:"actions,omitempty"`
}

// Field is a titled value on a card.
type Field struct {
	Title string `json:"title"`
	Value string `json:"value"`
	Short bool   `json:"short,omitempty"`
}

// Action is a button or a menu on a card.
type Action struct {
	ID      string   `json:"id"`
	Type    string   `json:"type"` // button, select
	Text    string   `json:"text"`
	Style   string   `json:"style,omitempty"` // default, primary, danger
	Value   string   `json:"value,omitempty"`
	Options []Option `json:"options,omitempty"`
}

// Option is a choice of a menu or a dialog's select.
type Option struct {
	Text  string `json:"text"`
	Value string `json:"value"`
}

// Dialog is a form a bot opens for a person.
type Dialog struct {
	Title       string    `json:"title"`
	SubmitLabel string    `json:"submit_label,omitempty"`
	State       string    `json:"state,omitempty"`
	Elements    []Element `json:"elements"`
}

// Element is a field of a dialog.
type Element struct {
	Name        string   `json:"name"`
	Label       string   `json:"label"`
	Type        string   `json:"type"` // text, textarea, select, checkbox, date
	Placeholder string   `json:"placeholder,omitempty"`
	Help        string   `json:"help,omitempty"`
	Optional    bool     `json:"optional,omitempty"`
	Value       string   `json:"value,omitempty"`
	MaxLength   int      `json:"max_length,omitempty"`
	Options     []Option `json:"options,omitempty"`
}

// Person and Channel name who and where.
type Person struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Channel is where something happened.
type Channel struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Command is a slash command someone ran.
type Command struct {
	Command     string `json:"command"`
	Text        string `json:"text"`
	UserID      string `json:"user_id"`
	UserName    string `json:"user_name"`
	ChannelID   string `json:"channel_id"`
	ChannelName string `json:"channel_name"`
	WorkspaceID string `json:"workspace_id"`
}

// CommandResponse answers a command: ephemeral (only the caller sees it, the
// default) or in_channel (posted as the bot), or a dialog.
type CommandResponse struct {
	ResponseType string       `json:"response_type,omitempty"`
	Text         string       `json:"text,omitempty"`
	Attachments  []Attachment `json:"attachments,omitempty"`
	Dialog       *Dialog      `json:"dialog,omitempty"`
}

// Interaction is a button pressed, a menu option chosen ("action") or a
// dialog submitted ("dialog_submission").
type Interaction struct {
	Type        string         `json:"type"`
	ActionID    string         `json:"action_id,omitempty"`
	Value       string         `json:"value,omitempty"`
	Attachment  int            `json:"attachment,omitempty"`
	DialogID    string         `json:"dialog_id,omitempty"`
	Values      map[string]any `json:"values,omitempty"`
	State       string         `json:"state,omitempty"`
	MessageID   string         `json:"message_id,omitempty"`
	User        Person         `json:"user"`
	Channel     Channel        `json:"channel"`
	WorkspaceID string         `json:"workspace_id"`
}

// InteractionResponse answers an interaction: a note for the person, a new
// text or cards for the message, a dialog to open, or a dialog's errors.
type InteractionResponse struct {
	Text   string            `json:"text,omitempty"`
	Update *Update           `json:"update,omitempty"`
	Dialog *Dialog           `json:"dialog,omitempty"`
	Errors map[string]string `json:"errors,omitempty"`
}

// Update replaces a message's text, cards or both (nil: unchanged).
type Update struct {
	Text        *string       `json:"text,omitempty"`
	Attachments *[]Attachment `json:"attachments,omitempty"`
}

// Event is a delivery of an event subscription.
type Event struct {
	ID        string         `json:"id"`
	Type      string         `json:"type"`
	CreatedAt string         `json:"created_at"`
	Data      map[string]any `json:"data"`
}

// Message is a message as the API returns it (the fields bots use most).
type Message struct {
	ID          string       `json:"id"`
	ChannelID   string       `json:"channel_id"`
	Body        string       `json:"body"`
	CreatedAt   string       `json:"created_at"`
	Attachments []Attachment `json:"attachments"`
}

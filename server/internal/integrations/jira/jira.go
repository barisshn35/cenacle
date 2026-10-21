// SPDX-License-Identifier: Apache-2.0

// Package jira turns Jira webhook events (Jira Cloud and Data Center send the
// same shape) into chat message cards.
package jira

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"unicode/utf8"

	"github.com/barisshn35/cenacle/server/internal/api"
)

type person struct {
	DisplayName string `json:"displayName"`
}

type named struct {
	Name string `json:"name"`
}

// Event is the part of a Jira webhook payload the chat uses.
type Event struct {
	WebhookEvent string  `json:"webhookEvent"`
	User         *person `json:"user"`
	Issue        *struct {
		Key    string `json:"key"`
		Self   string `json:"self"`
		Fields struct {
			Summary   string  `json:"summary"`
			Status    *named  `json:"status"`
			Priority  *named  `json:"priority"`
			IssueType *named  `json:"issuetype"`
			Assignee  *person `json:"assignee"`
		} `json:"fields"`
	} `json:"issue"`
	Changelog *struct {
		Items []struct {
			Field      string `json:"field"`
			FromString string `json:"fromString"`
			ToString   string `json:"toString"`
		} `json:"items"`
	} `json:"changelog"`
	Comment *struct {
		Body   json.RawMessage `json:"body"`
		Author *person         `json:"author"`
	} `json:"comment"`
}

// Changes worth telling, in this order.
var watched = []string{"status", "assignee", "priority", "summary"}

func ptr(s string) *string { return &s }

func truncate(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n-1]) + "…"
}

// browseURL is the issue's page: the address before /rest/ in "self", plus
// /browse/KEY. Only http(s) addresses are used.
func browseURL(self, key string) string {
	i := strings.Index(self, "/rest/")
	if i < 0 {
		return ""
	}
	u, err := url.Parse(self[:i] + "/browse/" + url.PathEscape(key))
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return ""
	}
	return u.String()
}

func nameOf(p *person) string {
	if p == nil || p.DisplayName == "" {
		return "Someone"
	}
	return p.DisplayName
}

// Card describes an event as a message card; ok is false for events that are
// not posted (unknown kinds, updates without a watched change).
func Card(payload []byte) (card api.Attachment, ok bool, err error) {
	var ev Event
	if err := json.Unmarshal(payload, &ev); err != nil {
		return card, false, fmt.Errorf("not a Jira event: %w", err)
	}
	if ev.Issue == nil || ev.Issue.Key == "" {
		return card, false, nil
	}
	is := ev.Issue
	title := truncate(is.Key+": "+is.Fields.Summary, 200)
	card.Title = &title
	if link := browseURL(is.Self, is.Key); link != "" {
		card.TitleLink = &link
	}
	color := func(c api.AttachmentColor) { card.Color = &c }
	kind := "issue"
	if is.Fields.IssueType != nil && is.Fields.IssueType.Name != "" {
		kind = is.Fields.IssueType.Name
	}

	switch ev.WebhookEvent {
	case "jira:issue_created":
		color("info")
		card.Text = ptr(fmt.Sprintf("%s created this %s.", nameOf(ev.User), strings.ToLower(kind)))
	case "jira:issue_deleted":
		color("danger")
		card.Text = ptr(fmt.Sprintf("%s deleted this %s.", nameOf(ev.User), strings.ToLower(kind)))
	case "jira:issue_updated", "issue_updated":
		if ev.Comment != nil && ev.Changelog == nil {
			return commentCard(card, ev)
		}
		var lines []string
		if ev.Changelog != nil {
			for _, f := range watched {
				for _, it := range ev.Changelog.Items {
					if strings.EqualFold(it.Field, f) {
						from, to := it.FromString, it.ToString
						if from == "" {
							from = "–"
						}
						if to == "" {
							to = "–"
						}
						lines = append(lines, fmt.Sprintf("**%s**: %s → %s", it.Field, truncate(from, 80), truncate(to, 80)))
					}
				}
			}
		}
		if len(lines) == 0 {
			return card, false, nil
		}
		color("neutral")
		if is.Fields.Status != nil && strings.EqualFold(is.Fields.Status.Name, "done") {
			color("success")
		}
		card.Text = ptr(nameOf(ev.User) + " changed this " + strings.ToLower(kind) + ".\n\n" + strings.Join(lines, "\n"))
	case "comment_created":
		return commentCard(card, ev)
	default:
		return card, false, nil
	}

	var fields []struct {
		Short *bool  `json:"short,omitempty"`
		Title string `json:"title"`
		Value string `json:"value"`
	}
	short := true
	add := func(title, value string) {
		if value != "" {
			fields = append(fields, struct {
				Short *bool  `json:"short,omitempty"`
				Title string `json:"title"`
				Value string `json:"value"`
			}{&short, title, truncate(value, 100)})
		}
	}
	if is.Fields.Status != nil {
		add("Status", is.Fields.Status.Name)
	}
	if is.Fields.Priority != nil {
		add("Priority", is.Fields.Priority.Name)
	}
	if is.Fields.Assignee != nil {
		add("Assignee", is.Fields.Assignee.DisplayName)
	}
	if len(fields) > 0 && ev.WebhookEvent != "jira:issue_deleted" {
		card.Fields = &fields
	}
	card.Footer = ptr("Jira")
	return card, true, nil
}

func commentCard(card api.Attachment, ev Event) (api.Attachment, bool, error) {
	var body string
	// Jira sends wiki markup as a string; documents in other formats are not shown.
	_ = json.Unmarshal(ev.Comment.Body, &body)
	text := nameOf(ev.Comment.Author) + " commented."
	if body = strings.TrimSpace(body); body != "" {
		text += "\n\n> " + strings.ReplaceAll(truncate(body, 500), "\n", "\n> ")
	}
	c := api.AttachmentColor("neutral")
	card.Color = &c
	card.Text = &text
	card.Footer = ptr("Jira")
	return card, true, nil
}

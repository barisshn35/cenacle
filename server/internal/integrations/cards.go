// SPDX-License-Identifier: AGPL-3.0-only

// Package integrations holds helpers shared by the built-in integrations.
package integrations

import (
	"net/url"
	"unicode/utf8"

	"github.com/barisshn35/cenacle/server/internal/api"
)

// Field is one field of a card.
type Field = struct {
	Short *bool  `json:"short,omitempty"`
	Title string `json:"title"`
	Value string `json:"value"`
}

// Ptr returns a pointer to a string.
func Ptr(s string) *string { return &s }

// Truncate shortens text to n characters with an ellipsis.
func Truncate(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n-1]) + "…"
}

// Link returns u when it is an absolute http(s) URL, else "".
func Link(u string) string {
	p, err := url.Parse(u)
	if err != nil || (p.Scheme != "https" && p.Scheme != "http") || p.Host == "" {
		return ""
	}
	return p.String()
}

// Card builds an attachment.
func Card(title, link, text string, color api.AttachmentColor, footer string, fields []Field) api.Attachment {
	a := api.Attachment{Color: &color}
	if title != "" {
		a.Title = Ptr(Truncate(title, 200))
	}
	if l := Link(link); l != "" {
		a.TitleLink = &l
	}
	if text != "" {
		a.Text = Ptr(Truncate(text, 2000))
	}
	if footer != "" {
		a.Footer = Ptr(footer)
	}
	if len(fields) > 0 {
		if len(fields) > 10 {
			fields = fields[:10]
		}
		for i := range fields {
			fields[i].Title = Truncate(fields[i].Title, 100)
			fields[i].Value = Truncate(fields[i].Value, 500)
		}
		a.Fields = &fields
	}
	return a
}

// ShortField is a field that shares a row.
func ShortField(title, value string) Field {
	t := true
	return Field{Short: &t, Title: title, Value: value}
}

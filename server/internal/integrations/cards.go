// SPDX-License-Identifier: AGPL-3.0-only

// Package integrations holds helpers shared by the built-in integrations.
package integrations

import (
	"net/url"
	"strings"
	"unicode/utf8"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
)

// Field is one field of a card.
type Field = struct {
	Short *bool  `json:"short,omitempty"`
	Title string `json:"title"`
	Value string `json:"value"`
}

// Ptr returns a pointer to a string.
func Ptr(s string) *string { return &s }

// Text makes what another service sent storable and displayable: invalid
// UTF-8 becomes U+FFFD, and control characters other than line breaks and
// tabs (NUL among them, which PostgreSQL does not store) are dropped.
func Text(s string) string {
	s = strings.ToValidUTF8(s, "\uFFFD")
	return strings.Map(func(r rune) rune {
		if r < 0x20 && r != '\n' && r != '\t' || r == 0x7f {
			return -1
		}
		return r
	}, s)
}

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
	title, text, footer = Text(title), Text(text), Text(footer)
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
			fields[i].Title = Truncate(Text(fields[i].Title), 100)
			fields[i].Value = Truncate(Text(fields[i].Value), 500)
		}
		a.Fields = &fields
	}
	return a
}

// CleanCard applies Text to every text of a card built by hand.
func CleanCard(a api.Attachment) api.Attachment {
	for _, p := range []*string{a.Title, a.Text, a.Footer, a.TitleLink} {
		if p != nil {
			*p = Text(*p)
		}
	}
	if a.Fields != nil {
		for i := range *a.Fields {
			(*a.Fields)[i].Title = Text((*a.Fields)[i].Title)
			(*a.Fields)[i].Value = Text((*a.Fields)[i].Value)
		}
	}
	return a
}

// ShortField is a field that shares a row.
func ShortField(title, value string) Field {
	t := true
	return Field{Short: &t, Title: title, Value: value}
}

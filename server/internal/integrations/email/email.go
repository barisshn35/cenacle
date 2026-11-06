// SPDX-License-Identifier: AGPL-3.0-only

// Package email turns an e-mail (as RFC 5322 text, piped by a mail server)
// into a message card: who sent it, its subject, its text and the names of
// its attachments.
package email

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"html"
	"io"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/mail"
	"regexp"
	"strings"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/integrations"
)

var (
	tagRE   = regexp.MustCompile(`(?s)<(script|style)[^>]*>.*?</(script|style)>|<[^>]+>`)
	blankRE = regexp.MustCompile(`\n{3,}`)
)

var decoder = new(mime.WordDecoder)

// text of an HTML part: tags dropped, entities read, blank lines folded.
func plain(htmlText string) string {
	s := strings.NewReplacer("<br>", "\n", "<br/>", "\n", "<br />", "\n", "</p>", "\n\n", "</div>", "\n").Replace(htmlText)
	s = html.UnescapeString(tagRE.ReplaceAllString(s, ""))
	return blankRE.ReplaceAllString(strings.TrimSpace(s), "\n\n")
}

func decodeBody(r io.Reader, encoding string) ([]byte, error) {
	switch strings.ToLower(strings.TrimSpace(encoding)) {
	case "base64":
		return io.ReadAll(base64.NewDecoder(base64.StdEncoding, r))
	case "quoted-printable":
		return io.ReadAll(quotedprintable.NewReader(r))
	default:
		return io.ReadAll(r)
	}
}

type parsed struct {
	text, html  string
	attachments []string
}

// walk reads a part (recursively through multiparts) for its text and attachments.
func walk(contentType, encoding, disposition string, body io.Reader, out *parsed, depth int) error {
	if depth > 10 {
		return nil
	}
	media, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		media = "text/plain"
	}
	if _, dparams, err := mime.ParseMediaType(disposition); err == nil && strings.HasPrefix(strings.ToLower(disposition), "attachment") {
		name := dparams["filename"]
		if name == "" {
			name = params["name"]
		}
		if decoded, err := decoder.DecodeHeader(name); err == nil {
			name = decoded
		}
		out.attachments = append(out.attachments, name)
		return nil
	}
	if strings.HasPrefix(media, "multipart/") {
		mr := multipart.NewReader(body, params["boundary"])
		for {
			p, err := mr.NextRawPart()
			if err == io.EOF {
				return nil
			}
			if err != nil {
				return err
			}
			if err := walk(p.Header.Get("Content-Type"), p.Header.Get("Content-Transfer-Encoding"),
				p.Header.Get("Content-Disposition"), p, out, depth+1); err != nil {
				return err
			}
		}
	}
	raw, err := decodeBody(body, encoding)
	if err != nil {
		return err
	}
	switch media {
	case "text/plain":
		if out.text == "" {
			out.text = string(raw)
		}
	case "text/html":
		if out.html == "" {
			out.html = string(raw)
		}
	default:
		if name := params["name"]; name != "" {
			out.attachments = append(out.attachments, name)
		}
	}
	return nil
}

// Card describes an e-mail.
func Card(raw []byte) (api.Attachment, bool, error) {
	msg, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		return api.Attachment{}, false, fmt.Errorf("not an e-mail: %w", err)
	}
	h := msg.Header
	ct := h.Get("Content-Type")
	if ct == "" {
		ct = "text/plain; charset=utf-8"
	}
	var p parsed
	if err := walk(ct, h.Get("Content-Transfer-Encoding"), h.Get("Content-Disposition"), msg.Body, &p, 0); err != nil {
		return api.Attachment{}, false, fmt.Errorf("unreadable e-mail: %w", err)
	}
	subject, err := decoder.DecodeHeader(h.Get("Subject"))
	if err != nil || strings.TrimSpace(subject) == "" {
		subject = "(no subject)"
	}
	from := h.Get("From")
	if addr, err := mail.ParseAddress(from); err == nil {
		from = addr.Address
		if addr.Name != "" {
			from = addr.Name + " <" + addr.Address + ">"
		}
	}
	text := strings.TrimSpace(strings.ReplaceAll(p.text, "\r\n", "\n"))
	if text == "" && p.html != "" {
		text = plain(p.html)
	}
	fields := []integrations.Field{integrations.ShortField("From", from)}
	if len(p.attachments) > 0 {
		fields = append(fields, integrations.ShortField("Attachments", strings.Join(p.attachments, ", ")))
	}
	return integrations.Card(subject, "", integrations.Truncate(text, 1900), "neutral", "E-mail", fields), true, nil
}

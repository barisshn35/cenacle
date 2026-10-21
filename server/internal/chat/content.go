// SPDX-License-Identifier: Apache-2.0

package chat

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/store"
)

// Limits of message content.
const (
	MaxMentions       = 50
	MaxAttachments    = 5
	MaxReactionKinds  = 50
	maxAttachmentText = 2000
)

// mentionPattern is how a message mentions someone: <@user-id>.
var mentionPattern = regexp.MustCompile(`<@([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})>`)

// mentionedIDs returns the distinct people a body mentions, at most MaxMentions.
func mentionedIDs(body string) []pgtype.UUID {
	var out []pgtype.UUID
	seen := map[openapi_types.UUID]bool{}
	for _, m := range mentionPattern.FindAllStringSubmatch(body, -1) {
		var id openapi_types.UUID
		if id.UnmarshalText([]byte(strings.ToLower(m[1]))) != nil || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, pgUUID(id))
		if len(out) == MaxMentions {
			break
		}
	}
	return out
}

func cleanText(s string, max int, multiline bool) (string, bool) {
	s = strings.TrimSpace(s)
	if !utf8.ValidString(s) || utf8.RuneCountInString(s) > max {
		return "", false
	}
	bad := strings.ContainsFunc(s, func(r rune) bool {
		return unicode.IsControl(r) && (!multiline || (r != '\n' && r != '\t'))
	})
	return s, !bad
}

// cleanAttachments checks message cards and returns them as stored (JSON).
func cleanAttachments(in *[]api.Attachment) ([]api.Attachment, []byte, string) {
	out := []api.Attachment{}
	if in == nil {
		return out, []byte("[]"), ""
	}
	if len(*in) > MaxAttachments {
		return nil, nil, "A message has up to 5 attachments."
	}
	for _, a := range *in {
		var c api.Attachment
		str := func(p *string, max int, multiline bool) (*string, bool) {
			if p == nil {
				return nil, true
			}
			v, ok := cleanText(*p, max, multiline)
			if !ok {
				return nil, false
			}
			if v == "" {
				return nil, true
			}
			return &v, true
		}
		var ok [4]bool
		c.Title, ok[0] = str(a.Title, 200, false)
		c.Text, ok[1] = str(a.Text, maxAttachmentText, true)
		c.Footer, ok[2] = str(a.Footer, 200, false)
		c.TitleLink, ok[3] = str(a.TitleLink, 2000, false)
		if !ok[0] || !ok[1] || !ok[2] || !ok[3] {
			return nil, nil, "An attachment text is too long or contains invalid characters."
		}
		if c.TitleLink != nil {
			u, err := url.Parse(*c.TitleLink)
			if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
				return nil, nil, "title_link must be an http(s) URL."
			}
		}
		if a.Color != nil {
			switch *a.Color {
			case "neutral", "info", "success", "warning", "danger":
				col := *a.Color
				c.Color = &col
			default:
				return nil, nil, "color must be neutral, info, success, warning or danger."
			}
		}
		if a.Fields != nil {
			if len(*a.Fields) > 10 {
				return nil, nil, "An attachment has up to 10 fields."
			}
			fields := *a.Fields
			for i := range fields {
				t, ok1 := cleanText(fields[i].Title, 100, false)
				v, ok2 := cleanText(fields[i].Value, 500, true)
				if !ok1 || !ok2 || t == "" || v == "" {
					return nil, nil, "Every field needs a title (up to 100 characters) and a value (up to 500)."
				}
				fields[i].Title, fields[i].Value = t, v
			}
			if len(fields) > 0 {
				c.Fields = &fields
			}
		}
		if c.Title == nil && c.Text == nil && c.Fields == nil {
			return nil, nil, "An attachment needs a title, a text or fields."
		}
		out = append(out, c)
	}
	raw, _ := json.Marshal(out)
	return out, raw, ""
}

// validEmoji accepts one emoji (a short grapheme cluster of symbol characters),
// not text that merely looks like one.
func validEmoji(s string) bool {
	if s == "" || len(s) > 64 || !utf8.ValidString(s) {
		return false
	}
	keycapBase, keycap := false, false
	for _, r := range s {
		switch {
		case r == 0x20E3:
			keycap = true
		case r == 0x200D, r == 0xFE0F: // joiner, emoji presentation
		case r >= 0x1F3FB && r <= 0x1F3FF: // skin tones
		case r >= 0xE0020 && r <= 0xE007F: // tag sequences (flags)
		case unicode.Is(unicode.So, r), unicode.Is(unicode.Sk, r):
		case r >= 0x1F1E6 && r <= 0x1F1FF: // regional indicators
		case r == '#' || r == '*' || (r >= '0' && r <= '9'): // keycap bases (1️⃣)
			keycapBase = true
		default:
			return false
		}
	}
	return (!keycapBase || keycap) && utf8.RuneCountInString(s) <= 16
}

// decorate fills mentions and reactions of messages for a reader.
func decorate(ctx context.Context, q store.Querier, reader pgtype.UUID, msgs []api.Message) error {
	if len(msgs) == 0 {
		return nil
	}
	ids := make([]pgtype.UUID, len(msgs))
	index := make(map[openapi_types.UUID]int, len(msgs))
	for i, m := range msgs {
		ids[i] = pgUUID(m.Id)
		index[m.Id] = i
	}
	mentions, err := q.ListMentions(ctx, ids)
	if err != nil {
		return err
	}
	for _, m := range mentions {
		i := index[uuid(m.MessageID)]
		msgs[i].Mentions = append(msgs[i].Mentions, api.Author{Id: uuid(m.UserID), DisplayName: m.DisplayName})
	}
	reactions, err := q.ListReactions(ctx, store.ListReactionsParams{UserID: reader, MessageIds: ids})
	if err != nil {
		return err
	}
	for _, r := range reactions {
		i := index[uuid(r.MessageID)]
		msgs[i].Reactions = append(msgs[i].Reactions, api.Reaction{Emoji: r.Emoji, Count: int(r.Count), Me: r.Me})
	}
	return nil
}

// errRollback ends a transaction without an error to report.
var errRollback = errors.New("rollback")

// inTx runs fn in a transaction with queries bound to it.
func (h *Handlers) inTx(ctx context.Context, fn func(q *store.Queries) error) error {
	tx, err := h.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := fn(store.New(tx)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// TxBeginner starts transactions (pgxpool.Pool).
type TxBeginner interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}

// emit records an event in the outbox with the given queries (inside the
// caller's transaction when it has one).
func emit(ctx context.Context, q store.Querier, typ string, data any) error {
	raw, err := json.Marshal(data)
	if err != nil {
		return err
	}
	return q.InsertOutboxEvent(ctx, store.InsertOutboxEventParams{Type: typ, Data: raw})
}

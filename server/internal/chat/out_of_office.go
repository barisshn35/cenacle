// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/auth"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

// MaxOutOfOfficeMessage is how long an automatic reply may be.
const MaxOutOfOfficeMessage = 500

// maxAbsence bounds how far ahead an absence may end.
const maxAbsence = 366 * 24 * time.Hour

// cleanOutOfOffice checks an absence: it ends in the future, within a year,
// after it starts, and its message is plain text of up to 500 characters.
func cleanOutOfOffice(in api.OutOfOffice, now time.Time) (api.OutOfOffice, bool) {
	msg := strings.TrimSpace(in.Message)
	if utf8.RuneCountInString(msg) > MaxOutOfOfficeMessage ||
		strings.ContainsFunc(msg, func(r rune) bool { return unicode.IsControl(r) && r != '\n' }) {
		return in, false
	}
	from, until := in.From.UTC(), in.Until.UTC()
	if !until.After(from) || !until.After(now) || until.Sub(now) > maxAbsence {
		return in, false
	}
	return api.OutOfOffice{From: from, Until: until, Message: msg}, true
}

func outOfOfficeAPI(from, until pgtype.Timestamptz, message string) *api.OutOfOffice {
	if !from.Valid || !until.Valid {
		return nil
	}
	return &api.OutOfOffice{From: from.Time, Until: until.Time, Message: message}
}

// SetOutOfOffice implements api.ServerInterface.
func (h *Handlers) SetOutOfOffice(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	if !h.allowAction(w, r, p.User) {
		return
	}
	var in api.OutOfOffice
	if !decode(w, r, &in) {
		return
	}
	o, valid := cleanOutOfOffice(in, time.Now())
	if !valid {
		badRequest(w, r, "An absence ends after it starts, in the future and within a year; its message has up to 500 characters.")
		return
	}
	if err := h.Queries.SetOutOfOffice(r.Context(), store.SetOutOfOfficeParams{
		ID: p.User.ID, FromAt: pgtype.Timestamptz{Time: o.From, Valid: true},
		UntilAt: pgtype.Timestamptz{Time: o.Until, Valid: true}, Message: o.Message,
	}); err != nil {
		h.unavailable(w, r, "set out of office", err)
		return
	}
	h.userUpdated(r.Context(), p.User.ID)
	h.writeMyProfile(w, r, p.User.ID)
}

// ClearOutOfOffice implements api.ServerInterface.
func (h *Handlers) ClearOutOfOffice(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	if !h.allowAction(w, r, p.User) {
		return
	}
	if err := h.Queries.ClearOutOfOffice(r.Context(), p.User.ID); err != nil {
		h.unavailable(w, r, "clear out of office", err)
		return
	}
	h.userUpdated(r.Context(), p.User.ID)
	w.WriteHeader(http.StatusNoContent)
}

// answerAbsent posts the automatic reply of the other person of a direct
// conversation who is out of office, once per conversation and absence,
// inside the sender's transaction. The reply carries their message (the app
// words an empty one) and when they are back.
func answerAbsent(ctx context.Context, q *store.Queries, c store.Channel, sender store.User) error {
	if c.Kind != KindDirect || c.Encrypted || c.Mls || sender.IsBot {
		return nil
	}
	away, err := q.ClaimOutOfOfficeReplies(ctx, store.ClaimOutOfOfficeRepliesParams{ChannelID: c.ID, SenderID: sender.ID})
	if err != nil || len(away) == 0 {
		return err
	}
	rows, err := q.GetProfiles(ctx, away)
	if err != nil {
		return err
	}
	for _, row := range rows {
		if !row.OooCurrent || !row.OooUntil.Valid {
			continue
		}
		author, err := q.GetUser(ctx, row.ID)
		if err != nil {
			return err
		}
		raw, err := json.Marshal([]api.Attachment{{AutoReply: &struct {
			Until time.Time `json:"until"`
		}{Until: row.OooUntil.Time}}})
		if err != nil {
			return err
		}
		if _, err := postMessageTo(ctx, q, c, author, row.OooMessage, "ooo-"+randomNonce(), raw, replyTo{},
			postExtras{noGroups: true}); err != nil {
			return err
		}
	}
	return nil
}

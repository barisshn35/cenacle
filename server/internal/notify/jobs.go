// SPDX-License-Identifier: Apache-2.0

package notify

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/barisshn35/cenacle/server/internal/store"
)

// Presence tells who is connected now (others are offline).
type Presence interface {
	Statuses(ctx context.Context, ids []string) (map[string]string, error)
}

func idString(id pgtype.UUID) string { return uuid.UUID(id.Bytes).String() }

func timeOf(t pgtype.Timestamptz) *time.Time {
	if !t.Valid {
		return nil
	}
	v := t.Time
	return &v
}

func location(name string) *time.Location {
	if name == "" {
		return time.UTC
	}
	if l, err := time.LoadLocation(name); err == nil {
		return l
	}
	return time.UTC
}

// excerpt shortens a message for a notification (Markdown left as typed).
func excerpt(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n]) + "…"
}

type recipient struct {
	prefs Prefs
	tz    *time.Location
	email string
	name  string
}

func recipients(ctx context.Context, q store.Querier, ids []pgtype.UUID) (map[pgtype.UUID]recipient, error) {
	rows, err := q.UsersForNotifying(ctx, ids)
	if err != nil {
		return nil, err
	}
	out := make(map[pgtype.UUID]recipient, len(rows))
	for _, u := range rows {
		r := recipient{prefs: Read(u.Prefs), tz: location(u.Timezone), name: u.DisplayName}
		if u.EmailVerified {
			r.email = u.Email
		}
		out[u.ID] = r
	}
	return out, nil
}

// --- web push -------------------------------------------------------------

const pushCursor = "push"

// Sender delivers one web push notification (Push; a fake in tests).
type Sender interface {
	Send(ctx context.Context, endpoint, p256dh, auth string, payload Payload) error
}

// Pusher tells offline people about new mentions and messages over web push.
type Pusher struct {
	Queries   *store.Queries
	Push      Sender
	Presence  Presence
	PublicURL string
	Log       *slog.Logger
	Now       func() time.Time
}

func (p *Pusher) now() time.Time {
	if p.Now != nil {
		return p.Now()
	}
	return time.Now()
}

// Run looks at the messages since the last run; it returns how many
// notifications went out.
func (p *Pusher) Run(ctx context.Context) (int, error) {
	q := p.Queries
	cursor, err := q.GetNotifyCursor(ctx, pushCursor)
	if errors.Is(err, pgx.ErrNoRows) {
		// First run: start from now, not from the history.
		newest, err := q.NewestMessageID(ctx)
		if err != nil {
			return 0, err
		}
		return 0, q.SetNotifyCursor(ctx, store.SetNotifyCursorParams{Name: pushCursor, Cursor: newest})
	}
	if err != nil {
		return 0, err
	}
	const limit = 2000
	rows, err := q.NotifyCandidates(ctx, store.NotifyCandidatesParams{After: cursor, RowLimit: limit})
	if err != nil || len(rows) == 0 {
		return 0, err
	}
	last := rows[len(rows)-1].MessageID
	if len(rows) == limit && rows[0].MessageID != last {
		// The page may end inside a message: that one comes again next time.
		for len(rows) > 0 && rows[len(rows)-1].MessageID == last {
			rows = rows[:len(rows)-1]
		}
		last = rows[len(rows)-1].MessageID
	}
	ids := make([]pgtype.UUID, 0, len(rows))
	strIDs := make([]string, 0, len(rows))
	seen := map[pgtype.UUID]bool{}
	for _, r := range rows {
		if !seen[r.UserID] {
			seen[r.UserID] = true
			ids = append(ids, r.UserID)
			strIDs = append(strIDs, idString(r.UserID))
		}
	}
	people, err := recipients(ctx, q, ids)
	if err != nil {
		return 0, err
	}
	online, err := p.Presence.Statuses(ctx, strIDs)
	if err != nil {
		online = map[string]string{} // offline it is: better told twice than never
	}
	sent := 0
	now := p.now()
	for _, r := range rows {
		who, ok := people[r.UserID]
		if !ok || !who.prefs.Push || online[idString(r.UserID)] != "" {
			continue
		}
		kind := KindOf(r.ChannelKind, r.Mentioned)
		if !Notifies(who.prefs, Channel{Level: r.Level, MutedUntil: timeOf(r.ChannelMutedUntil), WorkspaceMutedUntil: timeOf(r.WorkspaceMutedUntil)}, kind, now, who.tz) {
			continue
		}
		subs, err := q.ListPushSubscriptions(ctx, r.UserID)
		if err != nil {
			return sent, err
		}
		payload := Payload{
			Title: notificationTitle(r.AuthorName, r.ChannelName, r.ChannelKind),
			Body:  excerpt(r.Body, 160), URL: strings.TrimSuffix(p.PublicURL, "/") + "/c/" + idString(r.ChannelID),
			Tag: "c-" + idString(r.ChannelID), ChannelID: idString(r.ChannelID),
		}
		for _, s := range subs {
			err := p.Push.Send(ctx, s.Endpoint, s.P256dh, s.Auth, payload)
			switch {
			case errors.Is(err, ErrGone):
				_ = q.RemovePushEndpoint(ctx, s.Endpoint)
			case err != nil:
				p.Log.WarnContext(ctx, "web push", "error", err)
			default:
				sent++
			}
		}
	}
	return sent, q.SetNotifyCursor(ctx, store.SetNotifyCursorParams{Name: pushCursor, Cursor: last})
}

func notificationTitle(author, channel, kind string) string {
	if kind == "direct" || kind == "group" {
		return author
	}
	return author + " · " + channel
}

// --- e-mail ------------------------------------------------------------------

// Emailer sends people one e-mail about the mentions and conversation
// messages they have not read, after the delay they chose, while they are
// away.
type Emailer struct {
	Queries   *store.Queries
	SMTP      *SMTP
	Presence  Presence
	PublicURL string
	Log       *slog.Logger
	Now       func() time.Time
}

func (e *Emailer) now() time.Time {
	if e.Now != nil {
		return e.Now()
	}
	return time.Now()
}

// Run sends what is due; it returns how many e-mails went out.
func (e *Emailer) Run(ctx context.Context) (int, error) {
	q := e.Queries
	ids, err := q.EmailRecipients(ctx)
	if err != nil || len(ids) == 0 {
		return 0, err
	}
	people, err := recipients(ctx, q, ids)
	if err != nil {
		return 0, err
	}
	strIDs := make([]string, len(ids))
	for i, id := range ids {
		strIDs[i] = idString(id)
	}
	online, err := e.Presence.Statuses(ctx, strIDs)
	if err != nil {
		return 0, err // unsure who is away: try again later
	}
	sent := 0
	now := e.now()
	for _, id := range ids {
		who := people[id]
		if who.email == "" || online[idString(id)] != "" {
			continue
		}
		state, err := q.GetEmailNotification(ctx, id)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return sent, err
		}
		after := state.LastMessage
		if !after.Valid {
			after = pgtype.UUID{Valid: true} // the nil UUID: from the start (7 days at most)
		}
		rows, err := q.MissedForEmail(ctx, store.MissedForEmailParams{
			UserID: id, After: after, OlderThan: now.Add(-time.Duration(who.prefs.Email.DelayMinutes) * time.Minute),
		})
		if err != nil {
			return sent, err
		}
		if len(rows) == 0 {
			continue
		}
		var lines []string
		for _, r := range rows {
			kind := KindOf(r.ChannelKind, r.Mentioned)
			if Notifies(who.prefs, Channel{Level: r.Level, MutedUntil: timeOf(r.ChannelMutedUntil), WorkspaceMutedUntil: timeOf(r.WorkspaceMutedUntil)}, kind, now, who.tz) {
				lines = append(lines, fmt.Sprintf("%s — %s\n%s\n",
					notificationTitle(r.AuthorName, r.ChannelName, r.ChannelKind),
					r.CreatedAt.In(who.tz).Format("2006-01-02 15:04"), excerpt(r.Body, 300)))
			}
		}
		if InQuietHours(who.prefs, now, who.tz) || (who.prefs.PausedUntil != nil && now.Before(*who.prefs.PausedUntil)) {
			continue // after the quiet hours or the pause
		}
		lastID := rows[len(rows)-1].MessageID
		if len(lines) > 0 {
			if err := e.SMTP.Send(ctx, Mail{To: who.email, Subject: emailSubject(len(lines)), Text: emailText(who.name, lines, e.PublicURL)}); err != nil {
				e.Log.WarnContext(ctx, "e-mail notification", "error", err)
				continue // tried again on the next run
			}
			sent++
		}
		if err := q.SetEmailNotification(ctx, store.SetEmailNotificationParams{UserID: id, LastMessage: lastID}); err != nil {
			return sent, err
		}
	}
	return sent, nil
}

// The e-mail is in English and Turkish: the chat does not know people's
// language (the app keeps it in the browser).
func emailSubject(n int) string {
	return fmt.Sprintf("Cenacle: %d unread / %d okunmamış", n, n)
}

func emailText(name string, lines []string, publicURL string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Hello %s, while you were away: / Merhaba %s, sen yokken:\n\n", name, name)
	for _, l := range lines {
		b.WriteString(l)
		b.WriteString("\n")
	}
	fmt.Fprintf(&b, "Open Cenacle / Cenacle'ı aç: %s\n\n", strings.TrimSuffix(publicURL, "/")+"/")
	b.WriteString("You get these e-mails because you turned them on in Settings → Notifications.\n")
	b.WriteString("Bu e-postaları Ayarlar → Bildirimler'de açtığın için alıyorsun.\n")
	return b.String()
}

// SPDX-License-Identifier: AGPL-3.0-only

package notify

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Cenacle-TR/cenacle/server/internal/events"
	"github.com/Cenacle-TR/cenacle/server/internal/meetings"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

// Meetings reminds people of meetings starting soon (in the app, and by web
// push while they are away) and sends the e-mails about meetings (ADR 0054).
type Meetings struct {
	Queries   *store.Queries
	SMTP      MailRelay // nil: no e-mail
	Push      Sender    // nil: no web push
	Presence  Presence
	Sessions  SessionLimits
	PublicURL string
	Log       *slog.Logger
	Now       func() time.Time
}

func (m *Meetings) now() time.Time {
	if m.Now != nil {
		return m.Now()
	}
	return time.Now()
}

// Run gives the reminders that are due and sends waiting e-mails; it returns
// how many went out.
func (m *Meetings) Run(ctx context.Context) (int, error) {
	n, err := m.remind(ctx)
	if err != nil {
		return n, err
	}
	if m.SMTP != nil {
		relay, err := m.SMTP.Relay(ctx)
		if err != nil {
			return n, err
		}
		if relay != nil {
			sent, err := m.sendMails(ctx, relay)
			n += sent
			if err != nil {
				return n, err
			}
		}
	}
	if err := m.Queries.PruneMeetingReminders(ctx); err != nil {
		return n, err
	}
	return n, m.Queries.PruneMeetingMails(ctx)
}

// MeetingReminder is the data of a meeting.reminder event.
type MeetingReminder struct {
	To        []string  `json:"to"`
	MeetingID string    `json:"meeting_id"`
	ChannelID string    `json:"channel_id"`
	Title     string    `json:"title"`
	StartsAt  time.Time `json:"starts_at"`
}

const meetingReminderBody = "Starts soon / Birazdan başlıyor"

func (m *Meetings) remind(ctx context.Context) (int, error) {
	q := m.Queries
	rows, err := q.MeetingsSoon(ctx)
	if err != nil || len(rows) == 0 {
		return 0, err
	}
	ids := make([]pgtype.UUID, 0, len(rows))
	for _, r := range rows {
		ids = append(ids, r.UserID)
	}
	people, err := recipients(ctx, q, ids)
	if err != nil {
		return 0, err
	}
	now := m.now()
	// The next start of each meeting (from a minute ago).
	next := map[pgtype.UUID]time.Time{}
	sent := 0
	for _, r := range rows {
		start, ok := next[r.ID]
		if !ok {
			rule, err := meetings.ParseRule(r.Rrule)
			if err != nil {
				continue
			}
			meetings.Occurrences(r.StartsAt, location(r.Timezone), rule, r.Exdates, func(t time.Time) bool {
				if t.Before(now.Add(-time.Minute)) {
					return true
				}
				start = t
				return false
			})
			next[r.ID] = start
		}
		who, ok := people[r.UserID]
		if start.IsZero() || !ok || who.prefs.Meetings.RemindMinutes == 0 ||
			start.Sub(now) > time.Duration(who.prefs.Meetings.RemindMinutes)*time.Minute {
			continue
		}
		if n, err := q.AddMeetingReminder(ctx, store.AddMeetingReminderParams{
			MeetingID: r.ID, UserID: r.UserID, Occurrence: start,
		}); err != nil || n == 0 {
			if err != nil {
				return sent, err
			}
			continue // already reminded
		}
		user := idString(r.UserID)
		if InQuietHours(who.prefs, now, who.tz) || (who.prefs.PausedUntil != nil && now.Before(*who.prefs.PausedUntil)) {
			continue
		}
		data, _ := json.Marshal(MeetingReminder{To: []string{user}, MeetingID: idString(r.ID),
			ChannelID: idString(r.ChannelID), Title: r.Title, StartsAt: start})
		if err := q.InsertOutboxEvent(ctx, store.InsertOutboxEventParams{Type: events.MeetingReminder, Data: data}); err != nil {
			return sent, err
		}
		sent++
		if m.Push == nil || !who.prefs.Push {
			continue
		}
		if online, err := m.Presence.Statuses(ctx, []string{user}); err == nil && online[user] != "" {
			continue // the app shows it
		}
		policy, err := q.GetNotificationPolicy(ctx)
		if err != nil {
			return sent, err
		}
		payload := Payload{
			Title: r.Title, Body: meetingReminderBody,
			URL: strings.TrimSuffix(m.PublicURL, "/") + "/meetings/" + idString(r.ID),
			Tag: "meeting-" + idString(r.ID), ChannelID: idString(r.ChannelID),
		}
		if policy.PushContents == "none" {
			payload.Title, payload.Body = "Cenacle", newActivity
		}
		var limitsOK bool
		params := store.ListPushSubscriptionsParams{UserID: r.UserID}
		if m.Sessions != nil {
			if l, err := m.Sessions.Limits(ctx); err == nil {
				params.IdleTimeout, params.GuestIdleTimeout, params.MaxAge, params.GuestMaxAge = l.Idle, l.GuestIdle, l.MaxAge, l.GuestMaxAge
				limitsOK = true
			}
		}
		if !limitsOK && m.Sessions != nil {
			continue
		}
		subs, err := q.ListPushSubscriptions(ctx, params)
		if err != nil {
			return sent, err
		}
		for _, s := range subs {
			sendCtx, cancel := context.WithTimeout(ctx, pushTimeout)
			if err := m.Push.Send(sendCtx, s.Endpoint, s.P256dh, s.Auth, payload); err != nil {
				m.Log.WarnContext(ctx, "meeting reminder push", "error", err)
			}
			cancel()
		}
	}
	return sent, nil
}

func (m *Meetings) sendMails(ctx context.Context, relay *SMTP) (int, error) {
	q := m.Queries
	rows, err := q.DueMeetingMails(ctx)
	if err != nil || len(rows) == 0 {
		return 0, err
	}
	sent := 0
	now := m.now()
	for _, r := range rows {
		if err := ctx.Err(); err != nil {
			return sent, err
		}
		done := func() error {
			recCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), recordTimeout)
			defer cancel()
			return q.MarkMeetingMailsSent(recCtx, store.MarkMeetingMailsSentParams{MeetingID: r.MeetingID, UserID: r.UserID, ID: r.ID})
		}
		if r.UnsentInvite {
			// Never told of it: the newest e-mail is the invitation, as the
			// meeting is now; one cancelled meanwhile is not mentioned at all.
			if r.Kind == "cancel" {
				if err := done(); err != nil {
					return sent, err
				}
				continue
			}
			r.Kind, r.WasStartsAt, r.WasEndsAt = "invite", pgtype.Timestamptz{}, pgtype.Timestamptz{}
		}
		prefs := Read(r.Prefs)
		if r.Guest || !r.EmailVerified || r.Email == "" || !prefs.Meetings.Email {
			if err := done(); err != nil {
				return sent, err
			}
			continue
		}
		names, err := q.MeetingInviteeNames(ctx, r.MeetingID)
		if err != nil {
			return sent, err
		}
		total, err := q.CountMeetingInvitees(ctx, r.MeetingID)
		if err != nil {
			return sent, err
		}
		place := r.ChannelName
		if r.ChannelKind == "group" {
			place = r.ChannelTitle
		}
		mm := MeetingMail{
			Kind: r.Kind, MeetingID: idString(r.MeetingID), ChannelID: idString(r.ChannelID),
			Title: r.Title, Agenda: r.Agenda, Organizer: r.OrganizerName, OrganizerEmail: r.OrganizerEmail, Workspace: r.WorkspaceName,
			Start: r.StartsAt, End: r.EndsAt, TimeZone: r.Timezone, Rule: r.Rrule, Exdates: r.Exdates,
			Sequence: int(r.Sequence), PlaceKind: r.ChannelKind, PlaceName: place,
			People: names, PeopleTotal: int(total),
			Language: r.Language, RecipientTZ: r.UserTimezone, RecipientName: r.DisplayName, RecipientEmail: r.Email,
			PublicURL: m.PublicURL, From: relay.From,
		}
		if r.Kind == "cancel" {
			// Taken off a meeting that goes on (its own cancellation is "cancel" too).
			if meeting, err := q.GetMeeting(ctx, r.MeetingID); err == nil && !meeting.CancelledAt.Valid {
				mm.Removed = true
			}
		}
		if r.Kind == "update" && r.WasStartsAt.Valid {
			s := r.WasStartsAt.Time
			if r.WasEndsAt.Valid {
				e := r.WasEndsAt.Time
				mm.WasStart, mm.WasEnd = &s, &e
			} else {
				mm.Skipped = &s // one occurrence cancelled
			}
		}
		msg, err := RenderMeetingMail(mm, now)
		if err != nil {
			return sent, err
		}
		sendCtx, cancel := context.WithTimeout(ctx, sendTimeout)
		err = relay.Send(sendCtx, msg)
		cancel()
		if err != nil {
			m.Log.WarnContext(ctx, "meeting e-mail", "error", err)
			if err := q.MeetingMailFailed(ctx, r.ID); err != nil {
				return sent, err
			}
			continue // tried again on the next run
		}
		sent++
		if err := done(); err != nil {
			return sent, err
		}
	}
	return sent, nil
}

// SendSample sends one sample invitation (an administrator's test e-mail).
func (m *Meetings) SendSample(ctx context.Context, to, name, language, timezone string) error {
	if m.SMTP == nil {
		return errNoSMTP
	}
	relay, err := m.SMTP.Relay(ctx)
	if err != nil {
		return err
	}
	if relay == nil {
		return errNoSMTP
	}
	now := m.now()
	loc := location(timezone)
	day := now.In(loc).AddDate(0, 0, 7)
	start := time.Date(day.Year(), day.Month(), day.Day(), 14, 0, 0, 0, loc)
	title, agenda, workspace, place := "Sample meeting", "This is a test e-mail from Cenacle.\nIt shows how meeting invitations look.", "Cenacle", "general"
	if mailLanguage(language) == "tr" {
		title, agenda, place = "Örnek toplantı", "Bu, Cenacle'dan gönderilen bir deneme e-postasıdır.\nToplantı davetlerinin nasıl göründüğünü gösterir.", "genel"
	}
	msg, err := RenderMeetingMail(MeetingMail{
		Kind: "invite", MeetingID: "sample-" + now.UTC().Format("20060102T150405"), ChannelID: "",
		Title: title, Agenda: agenda, Organizer: name, Workspace: workspace,
		Start: start, End: start.Add(45 * time.Minute), TimeZone: loc.String(),
		PlaceKind: "public", PlaceName: place, People: []string{name}, PeopleTotal: 1,
		Language: language, RecipientTZ: timezone, RecipientName: name, RecipientEmail: to,
		PublicURL: m.PublicURL, From: relay.From,
	}, now)
	if err != nil {
		return err
	}
	sendCtx, cancel := context.WithTimeout(ctx, sendTimeout)
	defer cancel()
	return relay.Send(sendCtx, msg)
}

type mailError string

func (e mailError) Error() string { return string(e) }

const errNoSMTP = mailError("e-mail is not set up")

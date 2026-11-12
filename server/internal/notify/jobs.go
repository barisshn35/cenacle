// SPDX-License-Identifier: AGPL-3.0-only

package notify

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Cenacle-TR/cenacle/server/internal/auth"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
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

// lastPerson stands after every person in the cursor: the whole message is
// done.
var lastPerson = pgtype.UUID{Bytes: [16]byte{0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff}, Valid: true}

// sendTimeout bounds one e-mail: a slow relay holds up only its own
// notification, not the whole run.
const sendTimeout = 30 * time.Second

// recordTimeout bounds noting what was sent; it runs even when the run's
// context has just ended, so a sent notification is not sent again.
const recordTimeout = 10 * time.Second

const (
	// pushPage is how many candidates (a message and a person) are read at once.
	pushPage = 2000
	// pushWorkers is how many pushes go out at the same time: a slow push
	// service holds up one of them, not everyone's.
	pushWorkers = 16
	// pushPersonBudget is how long one person's pushes may take in a run;
	// the rest of theirs are dropped in this run, everyone else's go on.
	pushPersonBudget = 15 * time.Second
	// pushReserve: no new page is started this close to the run's deadline.
	pushReserve = 2 * pushTimeout
)

// Sender delivers one web push notification (Push; a fake in tests).
type Sender interface {
	Send(ctx context.Context, endpoint, p256dh, auth string, payload Payload) error
}

// SessionLimits gives the limits a session must be within to be used.
type SessionLimits interface {
	Limits(ctx context.Context) (auth.Limits, error)
}

// Pusher tells offline people about new mentions and messages over web push.
type Pusher struct {
	Queries   *store.Queries
	Push      Sender
	Presence  Presence
	Sessions  SessionLimits // nil: sessions end only by their expiry (tests)
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

func (p *Pusher) limits(ctx context.Context) (auth.Limits, error) {
	if p.Sessions != nil {
		return p.Sessions.Limits(ctx)
	}
	century := pgtype.Interval{Microseconds: (100 * 365 * 24 * time.Hour).Microseconds(), Valid: true}
	return auth.Limits{Idle: century, GuestIdle: century, MaxAge: century, GuestMaxAge: century}, nil
}

// pushKey is a place in the candidates: a message and a person.
type pushKey struct{ message, user pgtype.UUID }

func (p *Pusher) setCursor(ctx context.Context, k pushKey) error {
	return p.Queries.SetNotifyCursor(ctx, store.SetNotifyCursorParams{Name: pushCursor, Cursor: k.message, CursorUser: k.user})
}

// Run pushes about the messages since the last run, a page of candidates at
// a time until none are left or the run's time is nearly up; it returns how
// many notifications went out.
func (p *Pusher) Run(ctx context.Context) (int, error) {
	q := p.Queries
	c, err := q.GetNotifyCursor(ctx, pushCursor)
	if errors.Is(err, pgx.ErrNoRows) {
		// First run: start from now, not from the history.
		newest, err := q.NewestMessageID(ctx)
		if err != nil {
			return 0, err
		}
		return 0, p.setCursor(ctx, pushKey{newest, lastPerson})
	}
	if err != nil {
		return 0, err
	}
	limits, err := p.limits(ctx)
	if err != nil {
		return 0, err
	}
	policy, err := q.GetNotificationPolicy(ctx)
	if err != nil {
		return 0, err
	}
	// Calls first: a ring is late after half a minute.
	sent, err := p.ringCalls(ctx, limits, policy)
	if err != nil {
		p.Log.WarnContext(ctx, "call pushes", "error", err)
	}
	at := pushKey{c.Cursor, c.CursorUser}
	for {
		if deadline, ok := ctx.Deadline(); ok && time.Until(deadline) < pushReserve {
			return sent, nil // the rest on the next run
		}
		rows, err := q.NotifyCandidates(ctx, store.NotifyCandidatesParams{AfterMessage: at.message, AfterUser: at.user, RowLimit: pushPage})
		if err != nil || len(rows) == 0 {
			return sent, err
		}
		n, next, err := p.page(ctx, rows, at, limits, policy)
		sent += n
		if err != nil || len(rows) < pushPage {
			return sent, err
		}
		at = next
	}
}

// pushJob is one notification to one browser; row is its candidate.
type pushJob struct {
	row     int
	sub     store.ListPushSubscriptionsRow
	payload Payload
}

// page pushes one page of candidates and returns where the next one starts.
func (p *Pusher) page(ctx context.Context, rows []store.NotifyCandidatesRow, start pushKey, limits auth.Limits, policy store.GetNotificationPolicyRow) (int, pushKey, error) {
	q := p.Queries
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
		return 0, start, err
	}
	online, err := p.Presence.Statuses(ctx, strIDs)
	if err != nil {
		online = map[string]string{} // offline it is: better told twice than never
	}
	now := p.now()
	subsOf := map[pgtype.UUID][]store.ListPushSubscriptionsRow{}
	var jobs []pushJob
	for i, r := range rows {
		who, ok := people[r.UserID]
		if !ok || !who.prefs.Push || online[idString(r.UserID)] != "" {
			continue
		}
		kind := KindOf(r.ChannelKind, r.Mentioned)
		if !Notifies(who.prefs, Channel{Level: r.Level, MutedUntil: timeOf(r.ChannelMutedUntil), WorkspaceMutedUntil: timeOf(r.WorkspaceMutedUntil)}, kind, now, who.tz) {
			continue
		}
		subs, ok := subsOf[r.UserID]
		if !ok {
			subs, err = q.ListPushSubscriptions(ctx, store.ListPushSubscriptionsParams{
				UserID: r.UserID, IdleTimeout: limits.Idle, GuestIdleTimeout: limits.GuestIdle,
				MaxAge: limits.MaxAge, GuestMaxAge: limits.GuestMaxAge,
			})
			if err != nil {
				return 0, start, err
			}
			subsOf[r.UserID] = subs
		}
		payload := Payload{
			Title: notificationTitle(r.AuthorName, r.ChannelName, r.ChannelKind),
			Body:  excerpt(r.Body, 160), URL: strings.TrimSuffix(p.PublicURL, "/") + "/c/" + idString(r.ChannelID),
			Tag: "c-" + idString(r.ChannelID), ChannelID: idString(r.ChannelID),
		}
		// The notification policy: lock screens show what is pushed.
		switch policy.PushContents {
		case "sender":
			payload.Body = ""
		case "none":
			payload.Title, payload.Body = "Cenacle", newActivity
		}
		for _, s := range subs {
			jobs = append(jobs, pushJob{row: i, sub: s, payload: payload})
		}
	}
	keyOf := func(i int) pushKey { return pushKey{rows[i].MessageID, rows[i].UserID} }
	end := keyOf(len(rows) - 1)
	if len(jobs) == 0 {
		return 0, end, p.setCursor(ctx, end)
	}
	// At most once: the cursor moves past a message before its pushes go
	// out, so a run that crashes or runs next to another never pushes twice
	// (a lost push is the lesser harm: the message still waits, unread, in
	// the app). A run cut short gives back the pushes it had not started.
	claim := make([]int, len(rows)) // the last row of each row's message
	for i := len(rows) - 1; i >= 0; i-- {
		if i == len(rows)-1 || rows[i+1].MessageID != rows[i].MessageID {
			claim[i] = i
		} else {
			claim[i] = claim[i+1]
		}
	}
	d := &delivery{p: p, rows: rows, jobs: jobs, claim: claim, keyOf: keyOf, claimed: -1,
		failed: map[string]bool{}, spent: map[pgtype.UUID]time.Duration{}}
	var wg sync.WaitGroup
	for range min(pushWorkers, len(jobs)) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			d.work(ctx)
		}()
	}
	wg.Wait()
	if d.err == nil && d.next == len(jobs) {
		return d.sent, end, p.setCursor(ctx, end)
	}
	back := start
	if d.next > 0 {
		back = keyOf(jobs[d.next-1].row)
	}
	recCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), recordTimeout)
	defer cancel()
	if err := p.setCursor(recCtx, back); err != nil {
		return d.sent, back, err
	}
	if d.err != nil {
		return d.sent, back, d.err
	}
	return d.sent, back, ctx.Err()
}

// delivery sends a page's pushes with a few workers. Jobs start in order; a
// push endpoint that fails rests for the rest of the run (and for a while
// after it, longer each time), and a person whose pushes have used their
// budget gets no more in this run, so one person's slow endpoints delay only
// their own notifications.
type delivery struct {
	p     *Pusher
	rows  []store.NotifyCandidatesRow
	jobs  []pushJob
	claim []int
	keyOf func(int) pushKey

	mu      sync.Mutex
	next    int // the first job not started
	claimed int // the row the cursor was moved to
	err     error
	sent    int
	failed  map[string]bool
	spent   map[pgtype.UUID]time.Duration
}

// take starts the next job, moving the cursor past its message first.
func (d *delivery) take(ctx context.Context) (pushJob, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for d.err == nil && ctx.Err() == nil && d.next < len(d.jobs) {
		j := d.jobs[d.next]
		if c := d.claim[j.row]; c > d.claimed {
			if err := d.p.setCursor(ctx, d.keyOf(c)); err != nil {
				d.err = err
				return pushJob{}, false
			}
			d.claimed = c
		}
		d.next++
		if d.failed[j.sub.Endpoint] || d.spent[d.rows[j.row].UserID] >= pushPersonBudget {
			continue
		}
		return j, true
	}
	return pushJob{}, false
}

func (d *delivery) work(ctx context.Context) {
	q := d.p.Queries
	for {
		j, ok := d.take(ctx)
		if !ok {
			return
		}
		began := time.Now()
		sendCtx, cancel := context.WithTimeout(ctx, pushTimeout)
		err := d.p.Push.Send(sendCtx, j.sub.Endpoint, j.sub.P256dh, j.sub.Auth, j.payload)
		cancel()
		recCtx, cancelRec := context.WithTimeout(context.WithoutCancel(ctx), recordTimeout)
		d.mu.Lock()
		d.spent[d.rows[j.row].UserID] += time.Since(began)
		switch {
		case errors.Is(err, ErrGone):
			d.failed[j.sub.Endpoint] = true
			d.mu.Unlock()
			_ = q.RemovePushEndpoint(recCtx, j.sub.Endpoint)
		case err != nil && ctx.Err() != nil:
			d.mu.Unlock() // the run ended, not the endpoint
		case err != nil:
			d.failed[j.sub.Endpoint] = true
			d.mu.Unlock()
			d.p.Log.WarnContext(ctx, "web push", "error", err)
			_ = q.PushFailed(recCtx, j.sub.Endpoint)
		default:
			d.sent++
			d.mu.Unlock()
			if j.sub.Failures > 0 {
				_ = q.PushDelivered(recCtx, j.sub.Endpoint)
			}
		}
		cancelRec()
	}
}

// newActivity is the text of notifications that may show nothing (in both
// languages: the server does not know people's language).
const newActivity = "New activity / Yeni etkinlik"

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
	policy, err := q.GetNotificationPolicy(ctx)
	if err != nil {
		return 0, err
	}
	sent := 0
	now := e.now()
	for _, id := range ids {
		if err := ctx.Err(); err != nil {
			return sent, err // the rest on the next run
		}
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
				text := excerpt(r.Body, 300)
				if policy.EmailContents == "sender" {
					text = "" // the notification policy keeps the text in the app
				}
				lines = append(lines, fmt.Sprintf("%s — %s\n%s\n",
					notificationTitle(r.AuthorName, r.ChannelName, r.ChannelKind),
					r.CreatedAt.In(who.tz).Format("2006-01-02 15:04"), text))
			}
		}
		if InQuietHours(who.prefs, now, who.tz) || (who.prefs.PausedUntil != nil && now.Before(*who.prefs.PausedUntil)) {
			continue // after the quiet hours or the pause
		}
		lastID := rows[len(rows)-1].MessageID
		if len(lines) > 0 {
			sendCtx, cancel := context.WithTimeout(ctx, sendTimeout)
			err := e.SMTP.Send(sendCtx, Mail{To: who.email, Subject: emailSubject(len(lines)), Text: emailText(who.name, lines, e.PublicURL)})
			cancel()
			if err != nil {
				e.Log.WarnContext(ctx, "e-mail notification", "error", err)
				continue // tried again on the next run
			}
			sent++
		}
		// Noted right after each e-mail, also when the run's time is up:
		// otherwise the next run would send it again.
		recCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), recordTimeout)
		err = q.SetEmailNotification(recCtx, store.SetEmailNotificationParams{UserID: id, LastMessage: lastID})
		cancel()
		if err != nil {
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
	fmt.Fprintf(&b, "Hello %s, while you were away: / Merhaba %s, siz yokken:\n\n", name, name)
	for _, l := range lines {
		b.WriteString(l)
		b.WriteString("\n")
	}
	fmt.Fprintf(&b, "Open Cenacle / Cenacle'ı açın: %s\n\n", strings.TrimSuffix(publicURL, "/")+"/")
	b.WriteString("You get these e-mails because you turned them on in Settings → Notifications.\n")
	b.WriteString("Bu e-postaları Ayarlar → Bildirimler'de açtığınız için alıyorsunuz.\n")
	return b.String()
}

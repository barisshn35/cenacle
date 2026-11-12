// SPDX-License-Identifier: AGPL-3.0-only

package notify

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Cenacle-TR/cenacle/server/internal/auth"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

const callCursor = "push_calls"

// incomingCall is the text of a call's push (in both languages: the server
// does not know people's language).
const incomingCall = "Incoming call / Gelen arama"

// ringCalls pushes direct and group calls to the people they ring who are
// offline and let calls ring (Prefs.Calls.Ring), within their pause, quiet
// hours and muted conversations. At most once: the cursor passes the calls
// before their pushes go out.
func (p *Pusher) ringCalls(ctx context.Context, limits auth.Limits, policy store.GetNotificationPolicyRow) (int, error) {
	q := p.Queries
	c, err := q.GetNotifyCursor(ctx, callCursor)
	if errors.Is(err, pgx.ErrNoRows) {
		c.Cursor = pgtype.UUID{Valid: true} // the zero id: every call still ringing
	} else if err != nil {
		return 0, err
	}
	rows, err := q.RingCandidates(ctx, c.Cursor)
	if err != nil || len(rows) == 0 {
		return 0, err
	}
	if err := q.SetNotifyCursor(ctx, store.SetNotifyCursorParams{
		Name: callCursor, Cursor: rows[len(rows)-1].CallID, CursorUser: lastPerson,
	}); err != nil {
		return 0, err
	}
	ids := make([]pgtype.UUID, 0, len(rows))
	strIDs := make([]string, 0, len(rows))
	for _, r := range rows {
		ids = append(ids, r.UserID)
		strIDs = append(strIDs, idString(r.UserID))
	}
	people, err := recipients(ctx, q, ids)
	if err != nil {
		return 0, err
	}
	online, err := p.Presence.Statuses(ctx, strIDs)
	if err != nil {
		online = map[string]string{}
	}
	now := p.now()
	sent := 0
	for _, r := range rows {
		who, ok := people[r.UserID]
		if !ok || !who.prefs.Push || !who.prefs.Calls.Ring || online[idString(r.UserID)] != "" {
			continue
		}
		if !Notifies(who.prefs, Channel{Level: r.Level, MutedUntil: timeOf(r.ChannelMutedUntil), WorkspaceMutedUntil: timeOf(r.WorkspaceMutedUntil)}, Direct, now, who.tz) {
			continue
		}
		title := r.CallerName
		if r.ChannelKind == "group" && r.ChannelTitle != "" {
			title += " · " + r.ChannelTitle
		}
		payload := Payload{
			Title: title, Body: incomingCall,
			URL: strings.TrimSuffix(p.PublicURL, "/") + "/c/" + idString(r.ChannelID),
			Tag: "call-" + idString(r.CallID), ChannelID: idString(r.ChannelID),
		}
		if policy.PushContents == "none" {
			payload.Title, payload.Body = "Cenacle", newActivity
		}
		subs, err := q.ListPushSubscriptions(ctx, store.ListPushSubscriptionsParams{
			UserID: r.UserID, IdleTimeout: limits.Idle, GuestIdleTimeout: limits.GuestIdle,
			MaxAge: limits.MaxAge, GuestMaxAge: limits.GuestMaxAge,
		})
		if err != nil {
			return sent, err
		}
		for _, s := range subs {
			sendCtx, cancel := context.WithTimeout(ctx, pushTimeout)
			err := p.Push.Send(sendCtx, s.Endpoint, s.P256dh, s.Auth, payload)
			cancel()
			if err != nil {
				p.Log.WarnContext(ctx, "call push", "error", err)
				continue
			}
			sent++
		}
	}
	return sent, nil
}

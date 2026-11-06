// SPDX-License-Identifier: AGPL-3.0-only

package realtime

import (
	"context"
	"log/slog"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/valkey-io/valkey-go"

	"github.com/Cenacle-TR/cenacle/server/internal/events"
)

// Presence statuses. "offline" is the absence of a connection.
const (
	StatusOnline  = "online"
	StatusAway    = "away"
	StatusDND     = "dnd"
	StatusOffline = "offline"
)

// presenceTTL is how long a connection counts without a heartbeat.
const presenceTTL = 60 * time.Second

// Presence tracks who is connected, across instances, in Valkey:
//
//	cenacle:presence:conns:<user>  sorted set: connection id -> expiry (ms)
//	cenacle:presence:online        sorted set: user -> latest expiry (ms)
//	cenacle:presence:status        hash: user -> away | dnd (chosen by the user)
//
// A user goes online with their first connection and offline when the last
// one closes or stops sending heartbeats (a crashed instance); changes are
// published as presence.changed to the people of the user's workspaces.
type Presence struct {
	Valkey     events.ValkeyClient
	Ephemeral  *events.Ephemeral
	Workspaces func(ctx context.Context, user pgtype.UUID) ([]string, error)
	// Offline is told when a user goes offline (their "last seen"); optional.
	Offline func(ctx context.Context, user pgtype.UUID)
	Log     *slog.Logger
	now     func() time.Time
}

const (
	keyOnline = "cenacle:presence:online"
	keyStatus = "cenacle:presence:status"
)

func keyConns(user string) string { return "cenacle:presence:conns:" + user }

func (p *Presence) clock() time.Time {
	if p.now != nil {
		return p.now()
	}
	return time.Now()
}

func ms(t time.Time) string { return strconv.FormatInt(t.UnixMilli(), 10) }

// PresenceEvent is the data of presence.changed.
type PresenceEvent struct {
	UserID       string   `json:"user_id"`
	Status       string   `json:"status"`
	WorkspaceIDs []string `json:"workspace_ids"`
}

func (p *Presence) publish(ctx context.Context, user pgtype.UUID, status string) {
	ws, err := p.Workspaces(ctx, user)
	if err != nil {
		p.Log.Warn("presence: workspaces", "error", err)
		return
	}
	if err := p.Ephemeral.Publish(ctx, events.PresenceChanged, PresenceEvent{
		UserID: uuidString(user), Status: status, WorkspaceIDs: ws,
	}); err != nil {
		p.Log.Warn("presence: publish", "error", err)
	}
}

// touch records a heartbeat of a connection and returns how many live
// connections the user has.
func (p *Presence) touch(ctx context.Context, vc valkey.Client, user, conn string) (int64, error) {
	now := p.clock()
	res := vc.DoMulti(ctx,
		vc.B().Zadd().Key(keyConns(user)).ScoreMember().ScoreMember(float64(now.Add(presenceTTL).UnixMilli()), conn).Build(),
		vc.B().Zremrangebyscore().Key(keyConns(user)).Min("-inf").Max(ms(now)).Build(),
		vc.B().Zadd().Key(keyOnline).Gt().ScoreMember().ScoreMember(float64(now.Add(presenceTTL).UnixMilli()), user).Build(),
		vc.B().Pexpire().Key(keyConns(user)).Milliseconds(presenceTTL.Milliseconds()*2).Build(),
		vc.B().Zcard().Key(keyConns(user)).Build(),
	)
	for _, r := range res[:4] {
		if err := r.Error(); err != nil {
			return 0, err
		}
	}
	return res[4].AsInt64()
}

// Connected registers a connection; the first one makes the user online.
func (p *Presence) Connected(ctx context.Context, user pgtype.UUID, conn string) {
	vc, err := p.Valkey.Get()
	if err != nil {
		return
	}
	n, err := p.touch(ctx, vc, uuidString(user), conn)
	if err != nil {
		p.Log.Warn("presence: connect", "error", err)
		return
	}
	if n == 1 {
		p.publish(ctx, user, p.status(ctx, vc, uuidString(user)))
	}
}

// Heartbeat keeps a connection counted.
func (p *Presence) Heartbeat(ctx context.Context, user pgtype.UUID, conn string) {
	if vc, err := p.Valkey.Get(); err == nil {
		if _, err := p.touch(ctx, vc, uuidString(user), conn); err != nil {
			p.Log.Warn("presence: heartbeat", "error", err)
		}
	}
}

// Disconnected removes a connection; the last one makes the user offline.
func (p *Presence) Disconnected(ctx context.Context, user pgtype.UUID, conn string) {
	vc, err := p.Valkey.Get()
	if err != nil {
		return
	}
	u := uuidString(user)
	if err := vc.Do(ctx, vc.B().Zrem().Key(keyConns(u)).Member(conn).Build()).Error(); err != nil {
		return
	}
	p.maybeOffline(ctx, vc, user)
}

// maybeOffline publishes offline when the user has no live connection left;
// removing them from the online set decides which instance publishes.
func (p *Presence) maybeOffline(ctx context.Context, vc valkey.Client, user pgtype.UUID) {
	u := uuidString(user)
	now := p.clock()
	res := vc.DoMulti(ctx,
		vc.B().Zremrangebyscore().Key(keyConns(u)).Min("-inf").Max(ms(now)).Build(),
		vc.B().Zcard().Key(keyConns(u)).Build(),
	)
	if n, err := res[1].AsInt64(); err != nil || n > 0 {
		return
	}
	if removed, err := vc.Do(ctx, vc.B().Zrem().Key(keyOnline).Member(u).Build()).AsInt64(); err == nil && removed == 1 {
		if p.Offline != nil {
			p.Offline(ctx, user)
		}
		p.publish(ctx, user, StatusOffline)
	}
}

// RunSweeper takes users offline whose connections stopped sending
// heartbeats (for example after an instance crashed).
func (p *Presence) RunSweeper(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		vc, err := p.Valkey.Get()
		if err != nil {
			continue
		}
		users, err := vc.Do(ctx, vc.B().Zrangebyscore().Key(keyOnline).Min("-inf").Max(ms(p.clock())).Build()).AsStrSlice()
		if err != nil {
			continue
		}
		for _, u := range users {
			var id pgtype.UUID
			if id.Scan(u) == nil {
				p.maybeOffline(ctx, vc, id)
			}
		}
	}
}

func (p *Presence) status(ctx context.Context, vc valkey.Client, user string) string {
	s, err := vc.Do(ctx, vc.B().Hget().Key(keyStatus).Field(user).Build()).ToString()
	if err != nil || (s != StatusAway && s != StatusDND) {
		return StatusOnline
	}
	return s
}

// SetStatus stores a chosen status (online clears it) and tells others if
// the user is connected.
func (p *Presence) SetStatus(ctx context.Context, user pgtype.UUID, status string) error {
	vc, err := p.Valkey.Get()
	if err != nil {
		return err
	}
	u := uuidString(user)
	cmd := vc.B().Hset().Key(keyStatus).FieldValue().FieldValue(u, status).Build()
	if status == StatusOnline {
		cmd = vc.B().Hdel().Key(keyStatus).Field(u).Build()
	}
	if err := vc.Do(ctx, cmd).Error(); err != nil {
		return err
	}
	if score, err := vc.Do(ctx, vc.B().Zscore().Key(keyOnline).Member(u).Build()).AsFloat64(); err == nil &&
		int64(score) > p.clock().UnixMilli() {
		p.publish(ctx, user, status)
	}
	return nil
}

// Statuses returns the status of every connected user among ids.
func (p *Presence) Statuses(ctx context.Context, ids []string) (map[string]string, error) {
	vc, err := p.Valkey.Get()
	if err != nil {
		return nil, err
	}
	online, err := vc.Do(ctx, vc.B().Zrangebyscore().Key(keyOnline).Min(ms(p.clock())).Max("+inf").Build()).AsStrSlice()
	if err != nil {
		return nil, err
	}
	chosen, err := vc.Do(ctx, vc.B().Hgetall().Key(keyStatus).Build()).AsStrMap()
	if err != nil && !valkey.IsValkeyNil(err) {
		return nil, err
	}
	want := make(map[string]bool, len(ids))
	for _, id := range ids {
		want[id] = true
	}
	out := map[string]string{}
	for _, u := range online {
		if !want[u] {
			continue
		}
		out[u] = StatusOnline
		if s := chosen[u]; s == StatusAway || s == StatusDND {
			out[u] = s
		}
	}
	return out, nil
}

// WorkspacesOf lists a user's workspace ids from the membership source, for
// Presence.Workspaces.
func WorkspacesOf(m MembershipSource) func(context.Context, pgtype.UUID) ([]string, error) {
	return func(ctx context.Context, user pgtype.UUID) ([]string, error) {
		rows, err := m.ListUserWorkspaces(ctx, user)
		if err != nil {
			return nil, err
		}
		out := make([]string, len(rows))
		for i, row := range rows {
			out[i] = uuidString(row.Workspace.ID)
		}
		return out, nil
	}
}

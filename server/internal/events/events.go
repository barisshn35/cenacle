// SPDX-License-Identifier: Apache-2.0

// Package events is the ordered log of changes that clients receive live.
//
// The log is a Valkey stream: every server instance appends to it and
// follows it, so an event reaches clients connected to any instance. Stream
// ids ("<ms>-<seq>") are the event ids clients resume from. The stream keeps
// the latest MaxLen events; a client that was away longer reloads its data.
package events

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/valkey-io/valkey-go"
)

// Event is one change, as sent to clients.
type Event struct {
	ID   string          `json:"id"`
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

// Event types.
const (
	MessageCreated = "message.created"
	MessageUpdated = "message.updated"
	MessageDeleted = "message.deleted"
	// ChannelRead goes to the user who read (their other devices).
	ChannelRead = "channel.read"
	// CategoriesChanged goes to the members of a workspace.
	CategoriesChanged = "categories.changed"
	// WorkspaceJoined and WorkspaceLeft go to the user concerned (joined is also
	// sent when their role changes); WorkspaceUpdated and
	// WorkspaceMembersChanged to the workspace's members.
	WorkspaceJoined         = "workspace.joined"
	WorkspaceLeft           = "workspace.left"
	WorkspaceUpdated        = "workspace.updated"
	WorkspaceMembersChanged = "workspace.members_changed"
	ChannelCreated          = "channel.created"
	ChannelJoined           = "channel.joined"
	ChannelLeft             = "channel.left"
	// ChannelUpdated and ChannelMembersChanged go to the channel's members.
	ChannelUpdated        = "channel.updated"
	ChannelMembersChanged = "channel.members_changed"
)

// ID is a parsed stream id.
type ID struct{ Ms, Seq uint64 }

// ParseID parses "<ms>-<seq>".
func ParseID(s string) (ID, error) {
	ms, seq, ok := strings.Cut(s, "-")
	if !ok {
		return ID{}, fmt.Errorf("invalid event id %q", s)
	}
	a, err1 := strconv.ParseUint(ms, 10, 64)
	b, err2 := strconv.ParseUint(seq, 10, 64)
	if err1 != nil || err2 != nil {
		return ID{}, fmt.Errorf("invalid event id %q", s)
	}
	return ID{a, b}, nil
}

// Less reports whether id comes before o.
func (id ID) Less(o ID) bool {
	return id.Ms < o.Ms || (id.Ms == o.Ms && id.Seq < o.Seq)
}

func (id ID) String() string { return fmt.Sprintf("%d-%d", id.Ms, id.Seq) }

// ValkeyClient returns the Valkey connection (cache.Client.Get).
type ValkeyClient interface {
	Get() (valkey.Client, error)
}

// Log appends to and reads the event stream.
type Log struct {
	Valkey ValkeyClient
	// Key of the stream, e.g. "cenacle:events".
	Key string
	// MaxLen is roughly how many events are kept for resuming.
	MaxLen int64
}

const field = "e"

type payload struct {
	Type string          `json:"t"`
	Data json.RawMessage `json:"d"`
}

// Append adds an event and returns it with its id.
func (l *Log) Append(ctx context.Context, typ string, data any) (Event, error) {
	raw, err := json.Marshal(data)
	if err != nil {
		return Event{}, err
	}
	body, _ := json.Marshal(payload{Type: typ, Data: raw})
	vc, err := l.Valkey.Get()
	if err != nil {
		return Event{}, err
	}
	id, err := vc.Do(ctx, vc.B().Xadd().Key(l.Key).Maxlen().Almost().
		Threshold(strconv.FormatInt(l.MaxLen, 10)).Id("*").
		FieldValue().FieldValue(field, string(body)).Build()).ToString()
	if err != nil {
		return Event{}, fmt.Errorf("append event: %w", err)
	}
	return Event{ID: id, Type: typ, Data: raw}, nil
}

func decode(e valkey.XRangeEntry) (Event, error) {
	var p payload
	if err := json.Unmarshal([]byte(e.FieldValues[field]), &p); err != nil {
		return Event{}, fmt.Errorf("decode event %s: %w", e.ID, err)
	}
	return Event{ID: e.ID, Type: p.Type, Data: p.Data}, nil
}

// State is the position of the stream.
type State struct {
	// Last is the id of the newest event ever appended ("0-0" if none).
	Last ID
	// First is the id of the oldest event still kept.
	First ID
	// MaxDeleted is the newest id deleted with XDEL. (Trimming does not
	// update it; Trimmed covers that.)
	MaxDeleted ID
	// Trimmed reports that old events were removed.
	Trimmed bool
}

// Complete reports whether every event after `after` is still in the stream.
// Trimming removes the oldest events, so after an id older than the first kept
// one some may be missing. (An id equal to the one just before the first kept
// event counts as a gap too: the stream cannot tell, and a resync is harmless.)
func (st State) Complete(after ID) bool {
	if after.Less(st.MaxDeleted) || st.Last.Less(after) {
		return false
	}
	return !st.Trimmed || !after.Less(st.First)
}

// State reads the stream position (XINFO STREAM).
func (l *Log) State(ctx context.Context) (State, error) {
	vc, err := l.Valkey.Get()
	if err != nil {
		return State{}, err
	}
	info, err := vc.Do(ctx, vc.B().XinfoStream().Key(l.Key).Build()).AsMap()
	if err != nil {
		if strings.Contains(err.Error(), "no such key") {
			return State{}, nil
		}
		return State{}, fmt.Errorf("stream state: %w", err)
	}
	var st State
	for name, dst := range map[string]*ID{
		"last-generated-id": &st.Last, "max-deleted-entry-id": &st.MaxDeleted, "recorded-first-entry-id": &st.First,
	} {
		v := info[name]
		s, err := v.ToString()
		if err != nil {
			return State{}, fmt.Errorf("stream state %s: %w", name, err)
		}
		if *dst, err = ParseID(s); err != nil {
			return State{}, err
		}
	}
	addedMsg, lengthMsg := info["entries-added"], info["length"]
	added, err1 := addedMsg.AsInt64()
	length, err2 := lengthMsg.AsInt64()
	if err := errors.Join(err1, err2); err != nil {
		return State{}, fmt.Errorf("stream state: %w", err)
	}
	st.Trimmed = added > length
	return st, nil
}

// ErrGap means the events after an id are not (all) available any more.
var ErrGap = errors.New("events: gap since the given id")

// Since returns the events after `after`, at most limit of them. It returns
// ErrGap when some were trimmed, when there are more than limit, or when
// `after` is newer than the stream (Valkey lost its data).
func (l *Log) Since(ctx context.Context, after ID, limit int64) ([]Event, error) {
	st, err := l.State(ctx)
	if err != nil {
		return nil, err
	}
	if !st.Complete(after) {
		return nil, ErrGap
	}
	vc, err := l.Valkey.Get()
	if err != nil {
		return nil, err
	}
	entries, err := vc.Do(ctx, vc.B().Xrange().Key(l.Key).Start("("+after.String()).End("+").
		Count(limit+1).Build()).AsXRange()
	if err != nil && !valkey.IsValkeyNil(err) {
		return nil, fmt.Errorf("read events: %w", err)
	}
	if int64(len(entries)) > limit {
		return nil, ErrGap
	}
	out := make([]Event, 0, len(entries))
	for _, e := range entries {
		ev, err := decode(e)
		if err != nil {
			return nil, err
		}
		out = append(out, ev)
	}
	return out, nil
}

// Follow calls fn for every event appended after `after`, in order, until ctx
// ends or reading fails. It returns the id of the last event passed to fn.
func (l *Log) Follow(ctx context.Context, after ID, fn func(Event)) (ID, error) {
	vc, err := l.Valkey.Get()
	if err != nil {
		return after, err
	}
	for ctx.Err() == nil {
		res, err := vc.Do(ctx, vc.B().Xread().Count(256).Block((5 * time.Second).Milliseconds()).
			Streams().Key(l.Key).Id(after.String()).Build()).AsXRead()
		if valkey.IsValkeyNil(err) {
			continue // block timed out
		}
		if err != nil {
			return after, err
		}
		for _, e := range res[l.Key] {
			ev, err := decode(e)
			if err != nil {
				return after, err
			}
			id, err := ParseID(e.ID)
			if err != nil {
				return after, err
			}
			fn(ev)
			after = id
		}
	}
	return after, ctx.Err()
}

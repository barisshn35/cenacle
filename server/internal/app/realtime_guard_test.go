// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/realtime"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

// framesUntil reads event frames until a message.created with the given body
// and returns them all (that one included).
func framesUntil(t *testing.T, c *websocket.Conn, marker string) []frame {
	t.Helper()
	var out []frame
	for {
		f := read(t, c)
		out = append(out, f)
		if f.Op == "resync" {
			t.Fatal("resync instead of a resume")
		}
		if f.Type == "message.created" {
			var m message
			_ = json.Unmarshal(f.Data, &m)
			if m.Body == marker {
				return out
			}
		}
	}
}

// A resumed connection never gets back the text of messages removed since:
// deleted by their author, or removed by a spillage review (with the copies
// forwarded elsewhere).
func TestResumeSkipsRemovedMessages(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	owner := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	bob := s.user("sub-b", "Bob")
	general := s.general(ayse)
	s.general(bob)
	dm, _ := s.open(ayse, s.defaultWS, s.userID(bob))

	conn := s.connect(bob, "")
	start := read(t, conn).LastEventID
	_ = conn.Close(websocket.StatusNormalClosure, "")

	spilled, _ := s.send(ayse, general, "RESUME-SPILL secret", "guard-rg-nonce-1")
	if res := s.call(http.MethodPost, "/api/channels/"+general+"/messages/"+spilled.ID+"/forward", ayse,
		map[string]any{"channel_id": dm.ID, "comment": "fyi"}, nil); res.StatusCode != http.StatusCreated {
		t.Fatalf("forward = %d", res.StatusCode)
	}
	deleted, _ := s.send(ayse, general, "RESUME-DELETED secret", "guard-rg-nonce-2")
	if res := s.call(http.MethodDelete, "/api/channels/"+general+"/messages/"+deleted.ID, ayse, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("delete = %d", res.StatusCode)
	}
	var rep api.SpillageReport
	s.call(http.MethodPost, "/api/channels/"+general+"/messages/"+spilled.ID+"/spillage", bob, map[string]string{"reason": "secret"}, &rep)
	if res := s.call(http.MethodPost, "/api/spillage/"+rep.Id.String()+"/decision", owner, map[string]string{"decision": "remove"}, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("decide = %d", res.StatusCode)
	}
	s.send(ayse, general, "RESUME-MARKER", "guard-rg-nonce-3")

	conn = s.connect(bob, start)
	if hello := read(t, conn); hello.LastEventID != start {
		t.Fatalf("hello = %+v", hello)
	}
	removed := map[string]bool{}
	for _, f := range framesUntil(t, conn, "RESUME-MARKER") {
		if strings.Contains(string(f.Data), "RESUME-SPILL") || strings.Contains(string(f.Data), "RESUME-DELETED") {
			t.Errorf("resumed %s with removed text: %s", f.Type, f.Data)
		}
		if f.Type == "message.deleted" {
			var ref struct{ ID string }
			_ = json.Unmarshal(f.Data, &ref)
			removed[ref.ID] = true
		}
	}
	if !removed[spilled.ID] || !removed[deleted.ID] {
		t.Errorf("message.deleted resumed for %v", removed)
	}
}

// A resumed connection gets a channel's events from when its user joined
// it only: not what happened there before (edited or not).
func TestResumeSkipsEventsBeforeJoining(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	bob := s.user("sub-b", "Bob")
	var ops channel
	if res := s.call(http.MethodPost, "/api/channels", admin, map[string]any{"name": "Ops", "visibility": "private"}, &ops); res.StatusCode != http.StatusCreated {
		t.Fatalf("create = %d", res.StatusCode)
	}
	conn := s.connect(bob, "")
	start := read(t, conn).LastEventID
	_ = conn.Close(websocket.StatusNormalClosure, "")

	edited, _ := s.send(admin, ops.ID, "PREJOIN-ORIGINAL", "guard-pj-nonce-1")
	if res := s.call(http.MethodPatch, "/api/channels/"+ops.ID+"/messages/"+edited.ID, admin, map[string]string{"body": "PREJOIN-EDITED"}, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("edit = %d", res.StatusCode)
	}
	s.send(admin, ops.ID, "PREJOIN-PLAIN", "guard-pj-nonce-2")
	time.Sleep(20 * time.Millisecond) // the join comes a moment later
	if res := s.call(http.MethodPost, "/api/channels/"+ops.ID+"/members", admin, map[string]string{"user_id": s.userID(bob)}, nil); res.StatusCode >= 300 {
		t.Fatalf("add member = %d", res.StatusCode)
	}
	s.send(admin, ops.ID, "POSTJOIN-MARKER", "guard-pj-nonce-3")

	conn = s.connect(bob, start)
	read(t, conn) // hello
	for _, f := range framesUntil(t, conn, "POSTJOIN-MARKER") {
		if strings.Contains(string(f.Data), "PREJOIN-") {
			t.Errorf("resumed %s from before joining: %s", f.Type, f.Data)
		}
	}
}

// The frame of a new channel for everyone reaches only those in it: not a
// guest of the workspace.
func TestChannelForEveryoneFrameSkipsGuests(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	g := newGuestScene(s)
	guestConn := s.connect(g.guest, "")
	read(t, guestConn)
	friendConn := s.connect(g.friend, "")
	read(t, friendConn)
	time.Sleep(300 * time.Millisecond)

	var everyone channel
	if res := s.call(http.MethodPost, "/api/channels", g.admin, map[string]any{"name": "Hidden-Everyone", "topic": "t", "is_default": true}, &everyone); res.StatusCode != http.StatusCreated {
		t.Fatalf("create = %d", res.StatusCode)
	}
	s.send(g.admin, g.partners.ID, "CREATED-MARKER", "guard-ce-nonce-1")
	created := func(c *websocket.Conn) bool {
		seen := false
		for _, f := range framesUntil(t, c, "CREATED-MARKER") {
			seen = seen || (f.Type == "channel.created" && strings.Contains(string(f.Data), everyone.ID))
		}
		return seen
	}
	if created(guestConn) {
		t.Error("the guest received channel.created of a channel they are not in")
	}
	if !created(friendConn) {
		t.Error("a member did not receive channel.created")
	}
}

// countingMembers counts the membership reads of the realtime handler.
type countingMembers struct {
	realtime.MembershipSource
	n atomic.Int64
}

func (c *countingMembers) ListMemberChannelIDs(ctx context.Context, user pgtype.UUID) ([]store.ListMemberChannelIDsRow, error) {
	c.n.Add(1)
	return c.MembershipSource.ListMemberChannelIDs(ctx, user)
}

func (c *countingMembers) PeopleSharingChannels(ctx context.Context, arg store.PeopleSharingChannelsParams) ([]pgtype.UUID, error) {
	c.n.Add(1)
	return c.MembershipSource.PeopleSharingChannels(ctx, arg)
}

// Others joining and leaving a guest's channel make the guest's connection
// work out whom it sees at most once per GuestRefresh, however often.
func TestGuestRefreshIsCoalesced(t *testing.T) {
	counter := &countingMembers{}
	s := newStack(t, newShared(t), options{
		settings: realtime.Settings{Heartbeat: time.Second, SessionCheck: time.Second, QueueSize: 64, MaxBacklog: 50,
			GuestRefresh: 300 * time.Millisecond},
		members: func(m realtime.MembershipSource) realtime.MembershipSource {
			counter.MembershipSource = m
			return counter
		},
	})
	g := newGuestScene(s)
	var lobby channel
	if res := s.call(http.MethodPost, "/api/channels", g.admin, map[string]any{"name": "Lobby"}, &lobby); res.StatusCode != http.StatusCreated {
		t.Fatalf("create = %d", res.StatusCode)
	}
	if res := s.call(http.MethodPost, "/api/channels/"+lobby.ID+"/members", g.admin, map[string]string{"user_id": s.userID(g.guest)}, nil); res.StatusCode >= 300 {
		t.Fatalf("add guest = %d", res.StatusCode)
	}
	conn := s.connect(g.guest, "")
	read(t, conn)
	hiddenConn := s.connect(g.hidden, "")
	read(t, hiddenConn)
	time.Sleep(300 * time.Millisecond)

	before := counter.n.Load()
	for range 10 {
		s.call(http.MethodPost, "/api/channels/"+lobby.ID+"/join", g.hidden, nil, nil)
		s.call(http.MethodPost, "/api/channels/"+lobby.ID+"/leave", g.hidden, nil, nil)
	}
	s.call(http.MethodPost, "/api/channels/"+lobby.ID+"/join", g.hidden, nil, nil)
	s.send(g.admin, lobby.ID, "CYCLE-MARKER", "guard-cy-nonce-1")
	framesUntil(t, conn, "CYCLE-MARKER")
	time.Sleep(700 * time.Millisecond)
	if n := counter.n.Load() - before; n > 4 {
		t.Errorf("21 membership changes cost %d membership reads", n)
	}

	// Hidden stayed in the guest's channel: the guest sees them now.
	s.call(http.MethodPut, "/api/presence", g.hidden, map[string]string{"status": "away"}, nil)
	if who := presenceOf(t, conn, s.userID(g.guest)); who != s.userID(g.hidden) {
		t.Errorf("presence of %s, want Hidden", who)
	}
}

// Read receipts go both ways: a member who keeps theirs gets no one's live.
func TestReadReceiptsSkipMembersWhoKeepTheirs(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	mert := s.user("sub-m", "Mert")
	dm, _ := s.open(ayse, s.defaultWS, s.userID(mert))
	m, _ := s.send(mert, dm.ID, "okudun mu?", "guard-rk-nonce-1")
	if res := s.call(http.MethodPatch, "/api/workspaces/"+s.defaultWS, admin, map[string]bool{"read_receipts": true}, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("turn on = %d", res.StatusCode)
	}
	if res := s.call(http.MethodPatch, "/api/me/profile", mert, map[string]bool{"share_read_receipts": false}, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("keep = %d", res.StatusCode)
	}
	conn := s.connect(mert, "")
	read(t, conn)
	s.call(http.MethodPost, "/api/channels/"+dm.ID+"/read", ayse, map[string]string{"message_id": m.ID}, nil)
	s.send(ayse, dm.ID, "RECEIPT-MARKER", "guard-rk-nonce-2")
	for _, f := range framesUntil(t, conn, "RECEIPT-MARKER") {
		if f.Type == "conversation.read" {
			t.Errorf("a member who keeps their receipts got %s", f.Data)
		}
	}
}

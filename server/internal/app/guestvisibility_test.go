// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/groups"
)

// guestScene is a directory guest of the default workspace who shares a
// private channel with Friend only; Hidden shares nothing with them.
type guestScene struct {
	admin, guest, friend, hidden string
	partners                     channel
}

func newGuestScene(s *stack) guestScene {
	s.t.Helper()
	g := guestScene{admin: s.admin()}
	g.hidden = s.user("sub-hidden", "Hidden")
	g.friend = s.user("sub-friend", "Friend")
	g.guest = s.signInWith("sub-guest", "Guest", groups.Profile{Role: "guest"})
	s.call(http.MethodPost, "/api/channels", g.admin, map[string]any{"name": "Partners", "visibility": "private"}, &g.partners)
	for _, p := range []string{g.guest, g.friend} {
		if res := s.call(http.MethodPost, "/api/channels/"+g.partners.ID+"/members", g.admin, map[string]string{"user_id": s.userID(p)}, nil); res.StatusCode >= 300 {
			s.t.Fatalf("add member = %d", res.StatusCode)
		}
	}
	return g
}

// Guests hear of the presence of the people they may see only.
func TestGuestPresenceVisibility(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	g := newGuestScene(s)
	hiddenConn := s.connect(g.hidden, "")
	read(t, hiddenConn)
	friendConn := s.connect(g.friend, "")
	read(t, friendConn)
	guestConn := s.connect(g.guest, "")
	read(t, guestConn)
	time.Sleep(300 * time.Millisecond) // the guest's connection is listening

	s.call(http.MethodPut, "/api/presence", g.hidden, map[string]string{"status": "away"}, nil)
	s.call(http.MethodPut, "/api/presence", g.friend, map[string]string{"status": "dnd"}, nil)
	var p presence
	_ = json.Unmarshal(readEphemeral(t, guestConn, "presence.changed").Data, &p)
	for p.UserID == s.userID(g.guest) {
		_ = json.Unmarshal(readEphemeral(t, guestConn, "presence.changed").Data, &p)
	}
	if p.UserID != s.userID(g.friend) {
		t.Errorf("the guest heard first of %s (hidden is %s)", p.UserID, s.userID(g.hidden))
	}

	var list struct{ Presence []presence }
	if res := s.call(http.MethodGet, "/api/workspaces/"+s.defaultWS+"/presence", g.guest, nil, &list); res.StatusCode != http.StatusOK {
		t.Fatalf("presence = %d", res.StatusCode)
	}
	seen := map[string]bool{}
	for _, e := range list.Presence {
		seen[e.UserID] = true
	}
	if seen[s.userID(g.hidden)] || !seen[s.userID(g.friend)] {
		t.Errorf("guest's presence list = %+v", list.Presence)
	}
	s.call(http.MethodGet, "/api/workspaces/"+s.defaultWS+"/presence", g.admin, nil, &list)
	if len(list.Presence) < 3 {
		t.Errorf("admin's presence list = %+v", list.Presence)
	}
}

// Events and mention groups show a guest only the people they may see.
func TestGuestPeopleInEventsAndGroups(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	g := newGuestScene(s)
	start := time.Now().Add(2 * time.Hour).Truncate(time.Second)
	var e api.Event
	if res := s.call(http.MethodPost, "/api/workspaces/"+s.defaultWS+"/events", g.hidden, map[string]any{
		"title": "All hands", "starts_at": start, "ends_at": start.Add(time.Hour),
	}, &e); res.StatusCode != http.StatusCreated {
		t.Fatalf("event = %d", res.StatusCode)
	}
	for _, p := range []string{g.hidden, g.friend} {
		s.call(http.MethodPut, "/api/events/"+e.Id.String()+"/rsvp", p, map[string]any{"status": "going"}, nil)
	}
	var events struct{ Events []api.Event }
	s.call(http.MethodGet, "/api/workspaces/"+s.defaultWS+"/events", g.guest, nil, &events)
	if len(events.Events) != 1 {
		t.Fatalf("guest's events = %+v", events.Events)
	}
	ev := events.Events[0]
	if ev.CreatedBy != nil || len(ev.Going) != 1 || ev.Going[0].Id.String() != s.userID(g.friend) {
		t.Errorf("guest's event shows creator %+v, going %+v", ev.CreatedBy, ev.Going)
	}
	s.call(http.MethodGet, "/api/workspaces/"+s.defaultWS+"/events", g.admin, nil, &events)
	if ev := events.Events[0]; ev.CreatedBy == nil || len(ev.Going) != 2 {
		t.Errorf("admin's event shows creator %+v, going %+v", ev.CreatedBy, ev.Going)
	}

	var group api.MentionGroup
	if res := s.call(http.MethodPost, "/api/workspaces/"+s.defaultWS+"/mention-groups", g.admin, map[string]any{
		"handle": "crew", "name": "Crew", "member_ids": []string{s.userID(g.guest), s.userID(g.hidden), s.userID(g.friend)},
	}, &group); res.StatusCode != http.StatusCreated {
		t.Fatalf("create group = %d", res.StatusCode)
	}
	var out struct {
		Members []struct{ Person api.Person } `json:"members"`
	}
	if res := s.call(http.MethodGet, "/api/mention-groups/"+group.Id.String(), g.guest, nil, &out); res.StatusCode != http.StatusOK {
		t.Fatalf("guest gets group = %d", res.StatusCode)
	}
	for _, m := range out.Members {
		if m.Person.Id.String() == s.userID(g.hidden) {
			t.Errorf("the guest sees %s (%s) in the group", m.Person.DisplayName, m.Person.Email)
		}
	}
	if len(out.Members) != 3 {
		t.Errorf("guest's group members = %d, want 3 (themselves, Friend and the admin of Partners)", len(out.Members))
	}
}

// A new channel for everyone does not reach the live stream of a guest who
// is not in it; members get its messages.
func TestGuestMissesNewChannelForEveryone(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	g := newGuestScene(s)
	guestConn := s.connect(g.guest, "")
	read(t, guestConn)
	friendConn := s.connect(g.friend, "")
	read(t, friendConn)
	time.Sleep(300 * time.Millisecond)

	var everyone channel
	if res := s.call(http.MethodPost, "/api/channels", g.admin, map[string]any{"name": "Everyone", "is_default": true}, &everyone); res.StatusCode != http.StatusCreated {
		t.Fatalf("create = %d", res.StatusCode)
	}
	s.send(g.admin, everyone.ID, "for members", "n-everyone")
	s.send(g.admin, g.partners.ID, "marker", "n-marker")

	got := func(c *websocket.Conn) (everyoneSeen, markerSeen bool) {
		for !markerSeen {
			f := read(t, c)
			if f.Type != "message.created" {
				continue
			}
			var m message
			_ = json.Unmarshal(f.Data, &m)
			everyoneSeen = everyoneSeen || m.ChannelID == everyone.ID
			markerSeen = m.ChannelID == g.partners.ID
		}
		return
	}
	if seen, _ := got(guestConn); seen {
		t.Error("the guest received a message of the new channel for everyone")
	}
	if seen, _ := got(friendConn); !seen {
		t.Error("a member did not receive the message of the new channel for everyone")
	}
}

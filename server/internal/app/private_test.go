// SPDX-License-Identifier: Apache-2.0

package app_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/barisshn35/cenacle/server/internal/chat"
)

type member struct {
	User struct {
		ID          string `json:"id"`
		DisplayName string `json:"display_name"`
	} `json:"user"`
	Role string `json:"role"`
}

func (s *stack) members(token, channelID string) []member {
	s.t.Helper()
	var out struct{ Members []member }
	if res := s.call(http.MethodGet, "/api/channels/"+channelID+"/members", token, nil, &out); res.StatusCode != http.StatusOK {
		s.t.Fatalf("members = %d", res.StatusCode)
	}
	return out.Members
}

func (s *stack) userID(token string) string {
	s.t.Helper()
	var out struct {
		User struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	s.call(http.MethodGet, "/api/session", token, nil, &out)
	return out.User.ID
}

func TestPrivateChannels(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	mert := s.user("sub-m", "Mert")
	ayseID := s.userID(ayse)

	var private channel
	if res := s.call(http.MethodPost, "/api/channels", admin,
		map[string]any{"name": "Yönetim", "visibility": "private"}, &private); res.StatusCode != http.StatusCreated {
		t.Fatalf("create private = %d", res.StatusCode)
	}

	// Invisible and closed to non-members: 404, not 403, so it does not leak.
	for _, c := range s.channels(ayse, "/api/channels/directory") {
		if c.ID == private.ID {
			t.Fatal("private channel in a non-member's directory")
		}
	}
	for _, req := range []struct{ method, path string }{
		{http.MethodPost, "/api/channels/" + private.ID + "/join"},
		{http.MethodGet, "/api/channels/" + private.ID + "/messages"},
		{http.MethodGet, "/api/channels/" + private.ID + "/members"},
	} {
		if status, code := problemCode(t, s, req.method, req.path, ayse, nil); status != http.StatusNotFound || code != "not_found" {
			t.Errorf("%s %s by a non-member = %d %s", req.method, req.path, status, code)
		}
	}

	// The manager (creator) adds Ayşe; she sees it and can talk.
	var added member
	if res := s.call(http.MethodPost, "/api/channels/"+private.ID+"/members", admin,
		map[string]string{"user_id": ayseID}, &added); res.StatusCode != http.StatusOK || added.Role != "member" {
		t.Fatalf("add = %d %+v", res.StatusCode, added)
	}
	if s.channelID(ayse, "Yönetim") != private.ID {
		t.Fatal("added member does not see the channel")
	}
	if _, res := s.send(ayse, private.ID, "merhaba", "private-nonce-1"); res.StatusCode != http.StatusCreated {
		t.Errorf("member posting = %d", res.StatusCode)
	}
	list := s.members(ayse, private.ID)
	if len(list) != 2 || list[0].Role != "manager" || list[1].User.DisplayName != "Ayşe" {
		t.Errorf("members = %+v", list)
	}

	// A plain member cannot add or remove people, or change the channel.
	mertID := s.userID(mert)
	if status, code := problemCode(t, s, http.MethodPost, "/api/channels/"+private.ID+"/members", ayse,
		map[string]string{"user_id": mertID}); status != http.StatusForbidden || code != "forbidden" {
		t.Errorf("member adding = %d %s", status, code)
	}
	if status, _ := problemCode(t, s, http.MethodPatch, "/api/channels/"+private.ID, ayse,
		map[string]string{"visibility": "public"}); status != http.StatusForbidden {
		t.Errorf("member changing visibility = %d", status)
	}

	// The manager removes her again.
	if res := s.call(http.MethodDelete, "/api/channels/"+private.ID+"/members/"+ayseID, admin, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Errorf("remove = %d", res.StatusCode)
	}
	if status, _ := problemCode(t, s, http.MethodGet, "/api/channels/"+private.ID+"/messages", ayse, nil); status != http.StatusNotFound {
		t.Errorf("removed member reading = %d", status)
	}
}

func TestVisibilityChanges(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")

	var c channel
	s.call(http.MethodPost, "/api/channels", admin, map[string]any{"name": "Proje"}, &c)
	var updated channel
	if res := s.call(http.MethodPatch, "/api/channels/"+c.ID, admin, map[string]string{"visibility": "private"}, &updated); res.StatusCode != http.StatusOK {
		t.Fatalf("make private = %d", res.StatusCode)
	}
	if status, _ := problemCode(t, s, http.MethodPost, "/api/channels/"+c.ID+"/join", ayse, nil); status != http.StatusNotFound {
		t.Errorf("joining a channel made private = %d", status)
	}
	s.call(http.MethodPatch, "/api/channels/"+c.ID, admin, map[string]string{"visibility": "public"}, nil)
	if res := s.call(http.MethodPost, "/api/channels/"+c.ID+"/join", ayse, nil, nil); res.StatusCode != http.StatusOK {
		t.Errorf("joining a channel made public = %d", res.StatusCode)
	}

	// Channels for everyone stay public.
	general := s.general(admin)
	if status, _ := problemCode(t, s, http.MethodPatch, "/api/channels/"+general, admin, map[string]string{"visibility": "private"}); status != http.StatusBadRequest {
		t.Errorf("General made private = %d", status)
	}
	if status, _ := problemCode(t, s, http.MethodPost, "/api/channels", admin,
		map[string]any{"name": "Herkes gizli", "visibility": "private", "is_default": true}); status != http.StatusBadRequest {
		t.Errorf("private channel for everyone = %d", status)
	}
	if status, code := problemCode(t, s, http.MethodDelete, "/api/channels/"+s.channelID(admin, "Central")+"/members/"+s.userID(ayse), admin, nil); status != http.StatusForbidden || code != chat.CodeChannelMandatory {
		t.Errorf("removing from Central = %d %s", status, code)
	}
}

func TestSearchUsers(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ayse := s.user("sub-a", "Ayşe Yılmaz")
	s.user("sub-m", "Mert Demir")
	s.user("sub-p", "100% Yüzde")
	var out struct {
		Users []struct {
			DisplayName string `json:"display_name"`
		} `json:"users"`
	}
	s.call(http.MethodGet, "/api/users?q=mert", ayse, nil, &out)
	if len(out.Users) != 1 || out.Users[0].DisplayName != "Mert Demir" {
		t.Errorf("q=mert: %+v", out.Users)
	}
	// "%" is literal, not a wildcard.
	s.call(http.MethodGet, "/api/users?q=%25", ayse, nil, &out)
	if len(out.Users) != 1 || out.Users[0].DisplayName != "100% Yüzde" {
		t.Errorf("q=%%: %+v", out.Users)
	}
	if res := s.call(http.MethodGet, "/api/users?q=", ayse, nil, nil); res.StatusCode != http.StatusBadRequest {
		t.Errorf("empty query = %d", res.StatusCode)
	}
}

func TestMembershipEventsReachTheAddedUser(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	var private channel
	s.call(http.MethodPost, "/api/channels", admin, map[string]any{"name": "Gizli", "visibility": "private"}, &private)

	conn := s.connect(ayse, "")
	read(t, conn)
	s.call(http.MethodPost, "/api/channels/"+private.ID+"/members", admin, map[string]string{"user_id": s.userID(ayse)}, nil)
	if ev := read(t, conn); ev.Type != "channel.joined" {
		t.Fatalf("event = %s, want channel.joined", ev.Type)
	}
	if ev := read(t, conn); ev.Type != "channel.members_changed" {
		t.Fatalf("event = %s, want channel.members_changed", ev.Type)
	}
	s.send(admin, private.ID, "hoş geldin", "gizli-nonce-1")
	ev := read(t, conn)
	var m message
	_ = json.Unmarshal(ev.Data, &m)
	if ev.Type != "message.created" || m.Body != "hoş geldin" {
		t.Errorf("event = %s %q", ev.Type, m.Body)
	}
}

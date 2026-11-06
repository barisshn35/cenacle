// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"net/http"
	"testing"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/groups"
)

// mentionCount is the user's unread mentions in a channel.
func (s *stack) mentionCount(token, channelID string) int {
	s.t.Helper()
	var out struct {
		Channels []struct {
			ID           string `json:"id"`
			MentionCount int    `json:"mention_count"`
		}
	}
	s.call(http.MethodGet, "/api/channels", token, nil, &out)
	for _, c := range out.Channels {
		if c.ID == channelID {
			return c.MentionCount
		}
	}
	s.t.Fatalf("channel %s not listed", channelID)
	return 0
}

func TestMentionGroups(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	mert := s.user("sub-m", "Mert")
	zeynep := s.user("sub-z", "Zeynep")
	base := "/api/workspaces/" + s.defaultWS + "/mention-groups"

	// Ayşe creates @backend with Mert; she manages it.
	var g api.MentionGroup
	if res := s.call(http.MethodPost, base, ayse, map[string]any{
		"handle": "@Backend", "name": "Backend  team", "member_ids": []string{s.userID(mert)},
	}, &g); res.StatusCode != http.StatusCreated {
		t.Fatalf("create = %d", res.StatusCode)
	}
	if g.Handle != "backend" || g.Name != "Backend team" || g.MemberCount != 2 || !g.IsMember || !g.CanManage {
		t.Errorf("created = %+v", g)
	}
	for name, body := range map[string]map[string]any{
		"taken":    {"handle": "backend", "name": "x"},
		"reserved": {"handle": "here", "name": "x"},
		"bad":      {"handle": "-x", "name": "x"},
	} {
		want := http.StatusBadRequest
		if name == "taken" {
			want = http.StatusConflict
		}
		if status, _ := problemCode(t, s, http.MethodPost, base, mert, body); status != want {
			t.Errorf("%s handle = %d", name, status)
		}
	}

	// @backend in General reaches Mert (not the author, not Zeynep).
	general := s.general(ayse)
	s.send(ayse, general, "@backend lütfen bakın, @here değil", "mg-nonce-1")
	if n := s.mentionCount(mert, general); n != 1 {
		t.Errorf("mert mentions = %d", n)
	}
	if n := s.mentionCount(zeynep, general); n != 0 {
		t.Errorf("zeynep mentions = %d", n)
	}
	if n := s.mentionCount(ayse, general); n != 0 {
		t.Errorf("author mentions = %d", n)
	}

	// Members cannot change it; its manager can. Archived, it reaches no one.
	gid := g.Id.String()
	if status, _ := problemCode(t, s, http.MethodPatch, "/api/mention-groups/"+gid, mert, map[string]any{"name": "x"}); status != http.StatusForbidden {
		t.Errorf("member renames = %d", status)
	}
	if res := s.call(http.MethodPatch, "/api/mention-groups/"+gid, ayse, map[string]any{"archived": true}, &g); res.StatusCode != http.StatusOK || !g.Archived {
		t.Errorf("archive = %d %+v", res.StatusCode, g)
	}
	s.send(ayse, general, "@backend yine", "mg-nonce-2")
	if n := s.mentionCount(mert, general); n != 1 {
		t.Errorf("archived group reached: %d", n)
	}
	s.call(http.MethodPatch, "/api/mention-groups/"+gid, ayse, map[string]any{"archived": false}, &g)

	// The last manager cannot leave while others are in it; another manager can be made.
	ayseID := s.userID(ayse)
	if status, code := problemCode(t, s, http.MethodDelete, "/api/mention-groups/"+gid+"/members/"+ayseID, ayse, nil); status != http.StatusConflict || code != "last_manager" {
		t.Errorf("last manager leaves = %d %s", status, code)
	}
	if res := s.call(http.MethodPatch, "/api/mention-groups/"+gid+"/members/"+s.userID(mert), ayse, map[string]bool{"manager": true}, nil); res.StatusCode != http.StatusNoContent {
		t.Errorf("make manager = %d", res.StatusCode)
	}
	if res := s.call(http.MethodDelete, "/api/mention-groups/"+gid+"/members/"+ayseID, ayse, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Errorf("leave = %d", res.StatusCode)
	}
	var detail struct {
		Group   api.MentionGroup         `json:"group"`
		Members []api.MentionGroupMember `json:"members"`
	}
	s.call(http.MethodGet, "/api/mention-groups/"+gid, mert, nil, &detail)
	if len(detail.Members) != 1 || !detail.Members[0].Manager || !detail.Group.CanManage {
		t.Errorf("detail = %+v", detail)
	}

	// Administrators decide that only they create groups.
	if status, _ := problemCode(t, s, http.MethodPut, base+"/settings", ayse, map[string]string{"creation": "admins"}); status != http.StatusForbidden {
		t.Errorf("member changes the setting = %d", status)
	}
	if res := s.call(http.MethodPut, base+"/settings", admin, map[string]string{"creation": "admins"}, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("setting = %d", res.StatusCode)
	}
	if status, _ := problemCode(t, s, http.MethodPost, base, zeynep, map[string]any{"handle": "design", "name": "Design"}); status != http.StatusForbidden {
		t.Errorf("member creates after the change = %d", status)
	}
	var list struct {
		Groups    []api.MentionGroup `json:"groups"`
		CanCreate bool               `json:"can_create"`
		Creation  string             `json:"creation"`
	}
	s.call(http.MethodGet, base, zeynep, nil, &list)
	if list.CanCreate || list.Creation != "admins" || len(list.Groups) != 1 {
		t.Errorf("list = %+v", list)
	}

	// A group following a directory group has its people; they are not added by hand.
	s.applyProfile("sub-z", groups.Profile{Groups: []string{"Designers"}})
	var dir api.MentionGroup
	if res := s.call(http.MethodPost, base, admin, map[string]any{
		"handle": "design", "name": "Design", "directory_group": "designers",
	}, &dir); res.StatusCode != http.StatusCreated || dir.MemberCount != 1 || dir.DirectoryGroup == nil {
		t.Fatalf("directory group = %d %+v", res.StatusCode, dir)
	}
	if status, code := problemCode(t, s, http.MethodPost, "/api/mention-groups/"+dir.Id.String()+"/members", admin, map[string]any{"user_ids": []string{s.userID(mert)}}); status != http.StatusForbidden || code != "directory_group" {
		t.Errorf("adding to a directory group = %d %s", status, code)
	}
	s.send(mert, general, "@design bir göz atın", "mg-nonce-3")
	if n := s.mentionCount(zeynep, general); n != 1 {
		t.Errorf("directory group mention = %d", n)
	}
}

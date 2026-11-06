// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"net/http"
	"slices"
	"testing"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
)

func TestPermissionSchemes(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	ws := "/api/workspaces/" + s.defaultWS
	newChannel := map[string]any{"workspace_id": s.defaultWS, "name": "tasarım"}

	// The defaults of 0.33: members do not create channels or invite people.
	if status, _ := problemCode(t, s, http.MethodPost, "/api/channels", ayse, newChannel); status != http.StatusForbidden {
		t.Errorf("member creates a channel by default = %d", status)
	}
	if status, _ := problemCode(t, s, http.MethodPost, ws+"/invites", ayse, map[string]any{}); status != http.StatusForbidden {
		t.Errorf("member invites by default = %d", status)
	}
	if status, _ := problemCode(t, s, http.MethodPut, ws+"/permissions", ayse, map[string]any{"permissions": map[string][]string{}}); status != http.StatusForbidden {
		t.Errorf("member changes the scheme = %d", status)
	}
	if status, _ := problemCode(t, s, http.MethodPut, ws+"/permissions", admin, map[string]any{"permissions": map[string][]string{"fly": {"member"}}}); status != http.StatusBadRequest {
		t.Errorf("unknown permission = %d", status)
	}

	var changed api.Workspace
	res := s.call(http.MethodPut, ws+"/permissions", admin, map[string]any{"permissions": map[string][]string{
		"create_channels": {"admin", "member"}, "invite_people": {"member", "admin"}, "broadcast_mentions": {"admin"},
	}}, &changed)
	if res.StatusCode != http.StatusOK || changed.Permissions == nil || len((*changed.Permissions)["invite_people"]) != 2 {
		t.Fatalf("set scheme = %d %+v", res.StatusCode, changed.Permissions)
	}
	var list struct{ Workspaces []api.Workspace }
	s.call(http.MethodGet, "/api/workspaces", ayse, nil, &list)
	var mine api.Workspace
	for _, w := range list.Workspaces {
		if w.Id.String() == s.defaultWS {
			mine = w
		}
	}
	if mine.Can == nil || !slices.Contains(*mine.Can, "create_channels") || slices.Contains(*mine.Can, "broadcast_mentions") {
		t.Errorf("member can = %v", mine.Can)
	}
	if status, _ := problemCode(t, s, http.MethodPost, "/api/channels", ayse, newChannel); status != http.StatusCreated {
		t.Errorf("member creates a channel = %d", status)
	}
	s.invite(ayse, s.defaultWS, map[string]any{})

	// @here is the admins' now.
	general := s.general(ayse)
	if status, code := problemCode(t, s, http.MethodPost, "/api/channels/"+general+"/messages", ayse,
		map[string]any{"body": "@here toplantı", "nonce": "perm-nonce-1"}); status != http.StatusForbidden || code != "broadcast_not_allowed" {
		t.Errorf("member @here = %d %s", status, code)
	}
	if _, res := s.send(admin, general, "@here toplantı", "perm-nonce-2"); res.StatusCode != http.StatusCreated {
		t.Errorf("admin @here = %d", res.StatusCode)
	}
	// Nor by editing a message, or with a command.
	plain, _ := s.send(ayse, general, "toplantı", "perm-nonce-3")
	if status, code := problemCode(t, s, http.MethodPatch, "/api/channels/"+general+"/messages/"+plain.ID, ayse,
		map[string]any{"body": "@here toplantı"}); status != http.StatusForbidden || code != "broadcast_not_allowed" {
		t.Errorf("member edits in @here = %d %s", status, code)
	}
	if status, code := problemCode(t, s, http.MethodPost, "/api/channels/"+general+"/commands", ayse,
		map[string]string{"command": "shrug", "text": "@here toplantı"}); status != http.StatusForbidden || code != "broadcast_not_allowed" {
		t.Errorf("member /shrug @here = %d %s", status, code)
	}

	// Channel moderation: only managers post and react; replies stay open.
	m, _ := s.send(admin, general, "duyuru", "perm-nonce-3")
	var ch api.Channel
	res = s.call(http.MethodPatch, "/api/channels/"+general, admin, map[string]any{"moderation": map[string]string{
		"post": "managers", "reply": "everyone", "react": "managers", "broadcast": "everyone",
	}}, &ch)
	if res.StatusCode != http.StatusOK || ch.Moderation == nil || ch.Moderation.Post != api.ModerationRuleManagers {
		t.Fatalf("set moderation = %d %+v", res.StatusCode, ch.Moderation)
	}
	if _, res := s.send(ayse, general, "selam", "perm-nonce-4"); res.StatusCode != http.StatusForbidden {
		t.Errorf("member posts in a moderated channel = %d", res.StatusCode)
	}
	if status, _ := problemCode(t, s, http.MethodPut, "/api/channels/"+general+"/messages/"+m.ID+"/reactions/%F0%9F%91%8D", ayse, nil); status != http.StatusForbidden {
		t.Errorf("member reacts in a moderated channel = %d", status)
	}
	var all struct{ Channels []api.Channel }
	s.call(http.MethodGet, "/api/channels", ayse, nil, &all)
	var listed api.Channel
	for _, c := range all.Channels {
		if c.Id.String() == general {
			listed = c
		}
	}
	if listed.CanPost || listed.CanReact == nil || *listed.CanReact {
		t.Errorf("member's flags = post %v react %v", listed.CanPost, listed.CanReact)
	}
	if status, _ := problemCode(t, s, http.MethodPatch, "/api/channels/"+general, admin,
		map[string]any{"moderation": map[string]string{"post": "nobody", "reply": "everyone", "react": "everyone", "broadcast": "everyone"}}); status != http.StatusBadRequest {
		t.Errorf("bad rule = %d", status)
	}
}

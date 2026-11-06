// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"net/http"
	"testing"

	"github.com/Cenacle-TR/cenacle/server/internal/chat"
	"github.com/Cenacle-TR/cenacle/server/internal/groups"
)

// ruledScene: the attribute "team"; the admin and Lead are team red, the
// outsider has no team and is in the directory group "crew".
type ruledScene struct {
	admin, lead, outsider string
}

func newRuledScene(s *stack) ruledScene {
	s.t.Helper()
	r := ruledScene{admin: s.admin(), lead: s.user("sub-lead", "Lead")}
	r.outsider = s.signInWith("sub-out", "Outsider", groups.Profile{Groups: []string{"crew"}})
	ws := "/api/workspaces/" + s.defaultWS
	if res := s.call(http.MethodPut, ws+"/compliance", r.admin, map[string]any{
		"retention_days": nil, "classifications": []any{},
		"attributes": []map[string]any{{"key": "team", "name": "Team"}},
	}, nil); res.StatusCode != http.StatusOK {
		s.t.Fatalf("compliance = %d", res.StatusCode)
	}
	for _, p := range []string{r.admin, r.lead} {
		s.call(http.MethodPut, ws+"/member-attributes/"+s.userID(p), r.admin, map[string]string{"team": "red"}, nil)
	}
	return r
}

func (s *stack) setRules(admin, channelID string) {
	s.t.Helper()
	if res := s.call(http.MethodPut, "/api/channels/"+channelID+"/compliance", admin, map[string]any{
		"retention_days": nil, "access_rules": []map[string]any{{"key": "team", "values": []string{"red"}}},
	}, nil); res.StatusCode != http.StatusOK {
		s.t.Fatalf("rules = %d", res.StatusCode)
	}
}

func (s *stack) isMember(token, channelID, user string) bool {
	s.t.Helper()
	for _, m := range s.members(token, channelID) {
		if m.User.ID == user {
			return true
		}
	}
	return false
}

// A channel's access rules hold on every way in: group mappings, the
// welcome's suggested channels, guest links and webhooks.
func TestAccessRulesOnEveryEntry(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	r := newRuledScene(s)
	out := s.userID(r.outsider)

	// Group mapping by a channel manager who is not an admin.
	var ruled channel
	s.call(http.MethodPost, "/api/channels", r.admin, map[string]any{"name": "Ruled", "visibility": "private"}, &ruled)
	s.call(http.MethodPost, "/api/channels/"+ruled.ID+"/members", r.admin, map[string]string{"user_id": s.userID(r.lead)}, nil)
	s.setRules(r.admin, ruled.ID)
	s.call(http.MethodPatch, "/api/channels/"+ruled.ID+"/members/"+s.userID(r.lead), r.admin, map[string]string{"role": "manager"}, nil)
	if status, code := problemCode(t, s, http.MethodPost, "/api/channels/"+ruled.ID+"/members", r.lead, map[string]string{"user_id": out}); status != http.StatusForbidden || code != chat.CodeAccessRules {
		t.Fatalf("control: manual add = %d %s", status, code)
	}
	if res := s.call(http.MethodPut, "/api/channels/"+ruled.ID+"/groups", r.lead, map[string]any{"groups": []string{"crew"}, "managed": false}, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("map group = %d", res.StatusCode)
	}
	if s.isMember(r.lead, ruled.ID, out) {
		t.Error("a group mapping added the outsider to a channel with access rules")
	}
	// Meeting the rules later lets the group in on the next sign-in.
	s.call(http.MethodPut, "/api/workspaces/"+s.defaultWS+"/member-attributes/"+out, r.admin, map[string]string{"team": "red"}, nil)
	s.applyProfile("sub-out", groups.Profile{Groups: []string{"crew"}})
	if !s.isMember(r.lead, ruled.ID, out) {
		t.Error("the group did not add the outsider once they met the rules")
	}
	s.call(http.MethodPut, "/api/workspaces/"+s.defaultWS+"/member-attributes/"+out, r.admin, map[string]string{}, nil)

	// The welcome's suggestions: a ruled channel is not suggested, and rules
	// that come after the suggestion still hold at onboarding.
	var open, later channel
	s.call(http.MethodPost, "/api/channels", r.admin, map[string]any{"name": "Open"}, &open)
	s.call(http.MethodPost, "/api/channels", r.admin, map[string]any{"name": "Later"}, &later)
	s.setRules(r.admin, open.ID)
	welcome := "/api/workspaces/" + s.defaultWS + "/welcome"
	if res := s.call(http.MethodPut, welcome, r.admin, map[string]any{"message": "hi", "rules": []string{}, "channel_ids": []string{open.ID}}, nil); res.StatusCode != http.StatusBadRequest {
		t.Errorf("suggest a ruled channel = %d", res.StatusCode)
	}
	if res := s.call(http.MethodPut, welcome, r.admin, map[string]any{"message": "hi", "rules": []string{}, "channel_ids": []string{later.ID}}, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("welcome = %d", res.StatusCode)
	}
	s.setRules(r.admin, later.ID)
	if res := s.call(http.MethodPost, "/api/workspaces/"+s.defaultWS+"/onboarded", r.outsider, map[string]any{"join_channel_ids": []string{later.ID}}, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("onboarded = %d", res.StatusCode)
	}
	if s.isMember(r.admin, later.ID, out) {
		t.Error("onboarding added the outsider to a channel with access rules")
	}

	// Guest links: none for a ruled channel; a link from before the rules
	// lets nobody in.
	var linked channel
	s.call(http.MethodPost, "/api/channels", r.admin, map[string]any{"name": "Linked"}, &linked)
	var link struct{ Token string }
	if res := s.call(http.MethodPost, "/api/channels/"+linked.ID+"/guest-links", r.admin,
		map[string]any{"name": "early", "expires_in_hours": 1, "password": "guest-pass-1"}, &link); res.StatusCode != http.StatusCreated {
		t.Fatalf("create link = %d", res.StatusCode)
	}
	s.setRules(r.admin, linked.ID)
	if status, code := problemCode(t, s, http.MethodPost, "/api/channels/"+linked.ID+"/guest-links", r.admin,
		map[string]any{"name": "late", "expires_in_hours": 1, "password": "guest-pass-1"}); status != http.StatusForbidden || code != chat.CodeAccessRules {
		t.Errorf("link for a ruled channel = %d %s", status, code)
	}
	if status, code, _ := s.joinGuest(link.Token, "Guest", "guest-pass-1"); status != http.StatusForbidden || code != chat.CodeAccessRules {
		t.Errorf("join by an earlier link = %d %s", status, code)
	}

	// A webhook's bot joins only a channel whose rules it meets.
	b := s.newBot(r.admin, "Alarm")
	if status, code := problemCode(t, s, http.MethodPost, "/api/bots/"+b.ID+"/webhooks", r.admin,
		map[string]string{"name": "Alarm", "channel_id": linked.ID, "kind": "generic"}); status != http.StatusForbidden || code != chat.CodeAccessRules {
		t.Errorf("webhook into a ruled channel = %d %s", status, code)
	}

}

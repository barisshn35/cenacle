// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/integrations/signing"
)

func TestInteractiveMessages(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	general := s.general(ayse)
	b := s.newBot(admin, "Deploy")
	s.call(http.MethodPost, "/api/channels/"+general+"/members", admin, map[string]string{"user_id": b.UserID}, nil)
	var token struct{ Secret string }
	s.call(http.MethodPost, "/api/bots/"+b.ID+"/tokens", admin, map[string]any{"name": "app", "scopes": []string{"messages:write"}}, &token)
	rv := newReceiver(t)
	var setup struct{ Secret string }
	if res := s.call(http.MethodPut, "/api/bots/"+b.ID+"/interactions", admin, map[string]string{"url": rv.URL}, &setup); res.StatusCode != http.StatusOK || !strings.HasPrefix(setup.Secret, "cns_") {
		t.Fatalf("interactions = %d %q", res.StatusCode, setup.Secret)
	}

	// The bot posts a card with a button and a menu.
	var card api.Message
	res := s.call(http.MethodPost, "/api/channels/"+general+"/messages", token.Secret, map[string]any{
		"body": "", "nonce": "card-nonce-1",
		"attachments": []map[string]any{{
			"title": "Release 1.4",
			"actions": []map[string]any{
				{"id": "approve", "type": "button", "text": "Approve", "style": "primary", "value": "1.4"},
				{"id": "env", "type": "select", "text": "Environment", "options": []map[string]string{{"text": "Production", "value": "prod"}}},
			},
		}},
	}, &card)
	if res.StatusCode != http.StatusCreated || card.Attachments[0].Actions == nil || len(*card.Attachments[0].Actions) != 2 {
		t.Fatalf("card = %d %+v", res.StatusCode, card.Attachments)
	}
	if _, res := s.send(token.Secret, general, "", "card-nonce-x"); res == nil {
		t.Fatal("no response")
	}
	bad := s.call(http.MethodPost, "/api/channels/"+general+"/messages", token.Secret, map[string]any{
		"body": "x", "nonce": "card-nonce-2",
		"attachments": []map[string]any{{"title": "x", "actions": []map[string]any{{"id": "Bad Id", "type": "button", "text": "x"}}}},
	}, nil)
	if bad.StatusCode != http.StatusBadRequest {
		t.Errorf("bad action id = %d", bad.StatusCode)
	}

	// Pressing the button: the bot gets a signed request and updates the card.
	rv.set(http.StatusOK, `{"text": "Approved.", "update": {"attachments": [{"title": "Release 1.4", "text": "Approved by Ayşe",
		"actions": [{"id": "approve", "type": "button", "text": "Deploy", "value": "1.4"}]}]}}`)
	actions := "/api/channels/" + general + "/messages/" + card.Id.String() + "/actions"
	var result api.InteractionResult
	if res := s.call(http.MethodPost, actions, ayse, map[string]any{"attachment": 0, "action_id": "approve"}, &result); res.StatusCode != http.StatusOK ||
		result.Text == nil || *result.Text != "Approved." {
		t.Fatalf("press = %d %+v", res.StatusCode, result)
	}
	got := rv.received()
	if len(got) != 1 || !signing.Verify(setup.Secret, got[0].header.Get(signing.Header), got[0].body, time.Now(), time.Minute) {
		t.Fatalf("bot request = %d", len(got))
	}
	var sent struct {
		Type     string `json:"type"`
		ActionID string `json:"action_id"`
		Value    string `json:"value"`
		User     struct{ Name string }
	}
	_ = json.Unmarshal(got[0].body, &sent)
	if sent.Type != "action" || sent.ActionID != "approve" || sent.Value != "1.4" || sent.User.Name != "Ayşe" {
		t.Errorf("sent = %s", got[0].body)
	}
	var page api.MessagePage
	s.call(http.MethodGet, "/api/channels/"+general+"/messages", ayse, nil, &page)
	for _, m := range page.Messages {
		if m.Id == card.Id && (m.Attachments[0].Text == nil || *m.Attachments[0].Text != "Approved by Ayşe" || m.EditedAt != nil) {
			t.Errorf("updated card = %+v", m.Attachments)
		}
	}
	// A menu needs one of its options; unknown actions are not found.
	if status, _ := problemCode(t, s, http.MethodPost, actions, ayse, map[string]any{"attachment": 0, "action_id": "approve-nope"}); status != http.StatusNotFound {
		t.Errorf("unknown action = %d", status)
	}

	// A dialog: the bot opens it, a required field is checked, the bot refuses a value, then takes it.
	rv.set(http.StatusOK, `{"dialog": {"title": "Deploy", "submit_label": "Go", "state": "s1", "elements": [
		{"name": "reason", "label": "Reason", "type": "text"},
		{"name": "when", "label": "When", "type": "date", "optional": true}]}}`)
	// Pressing the (updated) button again opens it.
	result = api.InteractionResult{}
	s.call(http.MethodPost, actions, ayse, map[string]any{"attachment": 0, "action_id": "approve"}, &result)
	if result.Dialog == nil || result.Dialog.Title != "Deploy" || len(result.Dialog.Elements) != 2 {
		t.Fatalf("dialog = %+v", result)
	}
	dialog := "/api/dialogs/" + result.Dialog.Id.String()
	var answer api.InteractionResult
	s.call(http.MethodPost, dialog, ayse, map[string]any{"values": map[string]string{"when": "tomorrow"}}, &answer)
	if answer.Errors == nil || (*answer.Errors)["reason"] == "" || (*answer.Errors)["when"] == "" {
		t.Errorf("checked = %+v", answer)
	}
	rv.set(http.StatusOK, `{"errors": {"reason": "Say why."}}`)
	answer = api.InteractionResult{}
	s.call(http.MethodPost, dialog, ayse, map[string]any{"values": map[string]string{"reason": "x"}}, &answer)
	if answer.Errors == nil || (*answer.Errors)["reason"] != "Say why." {
		t.Errorf("refused = %+v", answer)
	}
	rv.set(http.StatusOK, `{"text": "Deploying."}`)
	answer = api.InteractionResult{}
	s.call(http.MethodPost, dialog, ayse, map[string]any{"values": map[string]string{"reason": "hotfix"}}, &answer)
	if answer.Text == nil || *answer.Text != "Deploying." {
		t.Errorf("submitted = %+v", answer)
	}
	last := rv.received()
	var sub struct {
		Type   string         `json:"type"`
		State  string         `json:"state"`
		Values map[string]any `json:"values"`
	}
	_ = json.Unmarshal(last[len(last)-1].body, &sub)
	if sub.Type != "dialog_submission" || sub.State != "s1" || sub.Values["reason"] != "hotfix" {
		t.Errorf("submission = %s", last[len(last)-1].body)
	}
	if status, _ := problemCode(t, s, http.MethodPost, dialog, ayse, map[string]any{"values": map[string]string{"reason": "again"}}); status != http.StatusNotFound {
		t.Errorf("submitted twice = %d", status)
	}

	// A failing bot is the bot's failure, not the server's.
	rv.set(http.StatusInternalServerError, "")
	if status, code := problemCode(t, s, http.MethodPost, actions, ayse, map[string]any{"attachment": 0, "action_id": "approve"}); status != http.StatusBadGateway || code != "bot_failed" {
		t.Errorf("failing bot = %d %s", status, code)
	}

	// A slash command can open a dialog too.
	s.call(http.MethodPost, "/api/bots/"+b.ID+"/commands", admin, map[string]string{"trigger": "ship", "url": rv.URL}, nil)
	rv.set(http.StatusOK, `{"dialog": {"title": "Ship", "elements": [{"name": "what", "label": "What", "type": "select", "options": [{"text": "API", "value": "api"}]}]}}`)
	var cmd struct {
		ResponseType string      `json:"response_type"`
		Dialog       *api.Dialog `json:"dialog"`
	}
	s.call(http.MethodPost, "/api/channels/"+general+"/commands", ayse, map[string]string{"command": "ship", "text": ""}, &cmd)
	if cmd.Dialog == nil || cmd.Dialog.SubmitLabel != "Submit" || len(cmd.Dialog.Elements) != 1 {
		t.Errorf("command dialog = %+v", cmd)
	}
	answer = api.InteractionResult{}
	s.call(http.MethodPost, "/api/dialogs/"+cmd.Dialog.Id.String(), ayse, map[string]any{"values": map[string]string{"what": "db"}}, &answer)
	if answer.Errors == nil || (*answer.Errors)["what"] == "" {
		t.Errorf("not an option = %+v", answer)
	}
}

// A timed-out member cannot have a bot act for them: commands, buttons and
// dialogs are refused before the bot is called; slow mode holds a command's
// answer like a message.
func TestTimedOutMemberCannotUseBots(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	general := s.general(ayse)
	s.general(admin)
	b := s.newBot(admin, "Relay")
	s.call(http.MethodPost, "/api/channels/"+general+"/members", admin, map[string]string{"user_id": b.UserID}, nil)
	var token struct{ Secret string }
	s.call(http.MethodPost, "/api/bots/"+b.ID+"/tokens", admin, map[string]any{"name": "app", "scopes": []string{"messages:write"}}, &token)
	rv := newReceiver(t)
	s.call(http.MethodPut, "/api/bots/"+b.ID+"/interactions", admin, map[string]string{"url": rv.URL}, nil)
	if res := s.call(http.MethodPost, "/api/bots/"+b.ID+"/commands", admin, map[string]string{"trigger": "relay", "url": rv.URL}, nil); res.StatusCode != http.StatusCreated {
		t.Fatalf("create command = %d", res.StatusCode)
	}
	var card api.Message
	s.call(http.MethodPost, "/api/channels/"+general+"/messages", token.Secret, map[string]any{
		"body": "", "nonce": "card-nonce-t",
		"attachments": []map[string]any{{"title": "x", "actions": []map[string]any{{"id": "go", "type": "button", "text": "Go"}}}},
	}, &card)
	rv.set(http.StatusOK, `{"dialog": {"title": "Relay", "elements": [{"name": "what", "label": "What", "type": "text"}]}}`)
	var cmd struct{ Dialog *api.Dialog }
	s.call(http.MethodPost, "/api/channels/"+general+"/commands", ayse, map[string]string{"command": "relay", "text": ""}, &cmd)
	if cmd.Dialog == nil {
		t.Fatal("no dialog")
	}

	// Slow mode: a member who just wrote waits before a command posts for them.
	s.call(http.MethodPatch, "/api/channels/"+general, admin, map[string]any{"slow_mode_seconds": 60}, nil)
	s.send(ayse, general, "first", "nonce-slow-t")
	rv.set(http.StatusOK, `{"response_type":"in_channel","text":"relayed"}`)
	if status, code := problemCode(t, s, http.MethodPost, "/api/channels/"+general+"/commands", ayse, map[string]string{"command": "relay", "text": "x"}); status != http.StatusTooManyRequests || code != "slow_mode" {
		t.Errorf("command in slow mode = %d %s", status, code)
	}
	s.call(http.MethodPatch, "/api/channels/"+general, admin, map[string]any{"slow_mode_seconds": 0}, nil)

	timeout := "/api/workspaces/" + s.defaultWS + "/members/" + s.userID(ayse) + "/timeout"
	if res := s.call(http.MethodPut, timeout, admin, map[string]any{"until": time.Now().Add(time.Hour)}, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("timeout = %d", res.StatusCode)
	}
	calls := len(rv.received())
	for name, req := range map[string]struct {
		path string
		body any
	}{
		"command": {"/api/channels/" + general + "/commands", map[string]string{"command": "relay", "text": "x"}},
		"action":  {"/api/channels/" + general + "/messages/" + card.Id.String() + "/actions", map[string]any{"attachment": 0, "action_id": "go"}},
		"dialog":  {"/api/dialogs/" + cmd.Dialog.Id.String(), map[string]any{"values": map[string]string{"what": "x"}}},
	} {
		if status, code := problemCode(t, s, http.MethodPost, req.path, ayse, req.body); status != http.StatusForbidden || code != "timed_out" {
			t.Errorf("%s while timed out = %d %s", name, status, code)
		}
	}
	if n := len(rv.received()); n != calls {
		t.Errorf("the bot was called %d times while timed out", n-calls)
	}
}

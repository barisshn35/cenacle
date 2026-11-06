// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"net/http"
	"strings"
	"testing"
)

// Bots cannot edit or delete messages: not their own, and not someone else's
// even when the bot account is a workspace owner and a channel manager, so the
// moderator branch of message deletion is out of reach of a bot token.
func TestBotsCannotEditOrDeleteMessages(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	general := s.general(ayse)

	var b bot
	if res := s.call(http.MethodPost, "/api/workspaces/"+s.defaultWS+"/bots", admin, map[string]string{"name": "Moderator"}, &b); res.StatusCode != http.StatusCreated {
		t.Fatalf("create bot = %d", res.StatusCode)
	}
	var created struct {
		Secret string `json:"secret"`
	}
	s.call(http.MethodPost, "/api/bots/"+b.ID+"/tokens", admin, map[string]any{"name": "all", "scopes": []string{"messages:write", "messages:read"}}, &created)
	if !strings.HasPrefix(created.Secret, "cnb_") {
		t.Fatalf("secret = %q", created.Secret)
	}
	token := created.Secret
	s.call(http.MethodPost, "/api/channels/"+general+"/members", admin, map[string]string{"user_id": b.UserID}, nil)

	own, res := s.send(token, general, "from the bot", "bot-nonce-own-1")
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("bot message = %d", res.StatusCode)
	}
	theirs, res := s.send(ayse, general, "from Ayşe", "ayse-nonce-1")
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("member message = %d", res.StatusCode)
	}

	// The bot account gets the highest roles a person could moderate with.
	for _, q := range []string{
		`UPDATE workspace_members SET role = 'owner' WHERE workspace_id = $1 AND user_id = $2`,
		`UPDATE channel_members SET role = 'manager' WHERE channel_id = $1 AND user_id = $2`,
	} {
		scope := s.defaultWS
		if strings.Contains(q, "channel_members") {
			scope = general
		}
		tag, err := s.pool.Exec(t.Context(), q, scope, b.UserID)
		if err != nil {
			t.Fatal(err)
		}
		if tag.RowsAffected() != 1 {
			t.Fatalf("%s: %d rows", q, tag.RowsAffected())
		}
	}

	for _, m := range []struct{ name, id string }{{"own", own.ID}, {"member's", theirs.ID}} {
		path := "/api/channels/" + general + "/messages/" + m.id
		if status, code := problemCode(t, s, http.MethodPatch, path, token, map[string]string{"body": "changed"}); status != http.StatusForbidden || code != "bot_not_allowed" {
			t.Errorf("bot PATCH %s message = %d %s", m.name, status, code)
		}
		if status, code := problemCode(t, s, http.MethodDelete, path, token, nil); status != http.StatusForbidden || code != "bot_not_allowed" {
			t.Errorf("bot DELETE %s message = %d %s", m.name, status, code)
		}
		var deleted, edited bool
		if err := s.pool.QueryRow(t.Context(), `SELECT deleted_at IS NOT NULL, edited_at IS NOT NULL FROM messages WHERE id = $1`, m.id).Scan(&deleted, &edited); err != nil {
			t.Fatal(err)
		}
		if deleted || edited {
			t.Errorf("%s message: deleted=%v edited=%v", m.name, deleted, edited)
		}
	}

	// A person with the same role does reach the moderator branch.
	if res := s.call(http.MethodDelete, "/api/channels/"+general+"/messages/"+theirs.ID, admin, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Errorf("owner deleting a member's message = %d", res.StatusCode)
	}
}

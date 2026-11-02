// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"context"
	"net/http"
	"testing"
	"time"
)

// moderate sets up the rules of moderation the tests below are held to:
// only admins mention everyone, and AutoMod blocks "bedava".
func (s *stack) moderate(admin string) {
	s.t.Helper()
	if res := s.call(http.MethodPut, "/api/workspaces/"+s.defaultWS+"/permissions", admin, map[string]any{
		"permissions": map[string][]string{"broadcast_mentions": {"admin"}},
	}, nil); res.StatusCode != http.StatusOK {
		s.t.Fatalf("set scheme = %d", res.StatusCode)
	}
	if res := s.call(http.MethodPost, "/api/workspaces/"+s.defaultWS+"/automod", admin, map[string]any{
		"name": "No spam", "kind": "keywords", "words": []string{"bedava"}, "action": "block",
	}, nil); res.StatusCode != http.StatusCreated {
		s.t.Fatalf("create rule = %d", res.StatusCode)
	}
}

// timeOut pauses a member's messages for an hour (until: nil ends it).
func (s *stack) timeOut(admin, user string, until any) {
	s.t.Helper()
	if res := s.call(http.MethodPut, "/api/workspaces/"+s.defaultWS+"/members/"+user+"/timeout", admin,
		map[string]any{"until": until}, nil); res.StatusCode != http.StatusNoContent {
		s.t.Fatalf("timeout = %d", res.StatusCode)
	}
}

// Scheduled messages meet the posting rules when scheduled and again when sent.
func TestScheduledMessagesFollowPostingRules(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ctx := context.Background()
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	mert := s.user("sub-m", "Mert")
	general := s.general(ayse)
	s.general(mert)
	path := "/api/channels/" + general + "/scheduled"
	later := time.Now().Add(time.Hour)
	// Mentioning everyone is allowed when scheduled, refused when sent once
	// the scheme no longer lets members do it.
	if res := s.call(http.MethodPost, path, mert, map[string]any{"body": "@channel duyuru", "send_at": later}, nil); res.StatusCode != http.StatusCreated {
		t.Fatalf("schedule a broadcast = %d", res.StatusCode)
	}
	s.moderate(admin)

	for body, want := range map[string]string{"@channel toplantı": "broadcast_not_allowed", "bedava kahve": "automod_blocked"} {
		if _, code := problemCode(t, s, http.MethodPost, path, ayse, map[string]any{"body": body, "send_at": later}); code != want {
			t.Errorf("scheduling %q = %s", body, code)
		}
	}
	if res := s.call(http.MethodPost, path, ayse, map[string]any{"body": "yarın görüşürüz", "send_at": later}, nil); res.StatusCode != http.StatusCreated {
		t.Fatalf("schedule = %d", res.StatusCode)
	}
	s.timeOut(admin, s.userID(ayse), time.Now().Add(time.Hour))
	if _, code := problemCode(t, s, http.MethodPost, path, ayse, map[string]any{"body": "hâlâ buradayım", "send_at": later}); code != "timed_out" {
		t.Errorf("scheduling while timed out = %s", code)
	}
	s.due()
	if _, err := s.bg.SendDueScheduled(ctx); err != nil {
		t.Fatal(err)
	}
	if n := s.count("SELECT count(*) FROM messages WHERE body IN ('yarın görüşürüz', '@channel duyuru')"); n != 0 {
		t.Errorf("%d refused scheduled messages were posted", n)
	}
	if n := s.count("SELECT count(*) FROM scheduled_messages WHERE status = 'failed' AND error <> ''"); n != 2 {
		t.Errorf("failed scheduled messages = %d", n)
	}
	if n := s.count("SELECT count(*) FROM message_mentions WHERE kind = 'channel'"); n != 0 {
		t.Errorf("channel mentions = %d", n)
	}
}

// A scheduled message that can no longer be sent (its conversation was
// encrypted since) fails alone: the rest of the batch goes out.
func TestScheduledMessageFailsAlone(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ctx := context.Background()
	ayse := s.user("sub-a", "Ayşe")
	mert := s.user("sub-m", "Mert")
	zeynep := s.user("sub-z", "Zeynep")
	general := s.general(zeynep)
	dm, status := s.open(ayse, s.defaultWS, s.userID(mert))
	if status != http.StatusCreated && status != http.StatusOK {
		t.Fatalf("open = %d", status)
	}
	later := time.Now().Add(time.Hour)
	s.call(http.MethodPost, "/api/channels/"+dm.ID+"/scheduled", ayse, map[string]any{"body": "sonra yazarım", "send_at": later}, nil)
	s.call(http.MethodPost, "/api/channels/"+general+"/scheduled", zeynep, map[string]any{"body": "günaydın herkese", "send_at": later}, nil)
	if _, err := s.pool.Exec(ctx, "UPDATE channels SET encrypted = true, mls = true WHERE id = $1", dm.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE scheduled_messages SET send_at = now() - CASE WHEN body = 'sonra yazarım'
		THEN interval '2 minutes' ELSE interval '1 minute' END`); err != nil {
		t.Fatal(err)
	}
	if n, err := s.bg.SendDueScheduled(ctx); err != nil || n != 2 {
		t.Fatalf("sent %d, %v", n, err)
	}
	if n := s.count("SELECT count(*) FROM messages WHERE body = 'günaydın herkese'"); n != 1 {
		t.Errorf("the healthy message was posted %d times", n)
	}
	if n := s.count("SELECT count(*) FROM scheduled_messages WHERE body = 'sonra yazarım' AND status = 'failed'"); n != 1 {
		t.Error("the message for the encrypted conversation did not fail")
	}
}

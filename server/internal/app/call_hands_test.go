// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/Cenacle-TR/cenacle/server/internal/config"
)

func TestCallHandsAndReactions(t *testing.T) {
	shared := newShared(t)
	// Unique per run: the shared Valkey keeps a node for a minute.
	node := "test-media-hands-" + uuid.NewString()[:8]
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	s := newStack(t, shared, options{calls: &config.Calls{Private: private, KeyID: "test-calls", NodeID: node}})
	ctx := context.Background()
	if err = shared.valkey.PutNew(ctx, "cenacle:media:node:"+node, []byte(uuid.NewString()), time.Minute); err != nil {
		t.Fatal(err)
	}
	ayse := s.user("hands-a", "Ayşe")
	mert := s.user("hands-m", "Mert")
	channel := s.general(ayse)
	s.general(mert)
	if _, err = s.pool.Exec(ctx, "UPDATE workspaces SET calls_enabled = true WHERE id = $1", s.defaultWS); err != nil {
		t.Fatal(err)
	}
	var call struct {
		ID           string `json:"id"`
		Participants []struct {
			UserID       string     `json:"user_id"`
			HandRaisedAt *time.Time `json:"hand_raised_at"`
		} `json:"participants"`
	}
	s.call(http.MethodPost, "/api/channels/"+channel+"/calls", ayse, map[string]any{"nonce": uuid.NewString()}, &call)
	for _, token := range []string{ayse, mert} {
		if res := s.call(http.MethodPost, "/api/calls/"+call.ID+"/token", token, nil, nil); res.StatusCode != http.StatusOK {
			t.Fatalf("token = %d", res.StatusCode)
		}
	}
	// The sidebar learns of the call from the workspace's list of calls in one's channels.
	var active struct {
		Calls []struct {
			ID string `json:"id"`
		} `json:"calls"`
	}
	s.call(http.MethodGet, "/api/workspaces/"+s.defaultWS+"/calls", mert, nil, &active)
	if len(active.Calls) != 1 || active.Calls[0].ID != call.ID {
		t.Errorf("active calls = %+v", active.Calls)
	}
	// Mert has not connected yet: no hand, no reaction.
	if status, _ := problemCode(t, s, http.MethodPost, "/api/calls/"+call.ID+"/reactions", mert, map[string]string{"emoji": "👏"}); status != http.StatusConflict {
		t.Errorf("reaction before connecting = %d", status)
	}
	if _, err = s.pool.Exec(ctx, "UPDATE call_participants SET state = 'connected', joined_at = now() WHERE call_id = $1", call.ID); err != nil {
		t.Fatal(err)
	}

	if res := s.call(http.MethodPut, "/api/calls/"+call.ID+"/hand", mert, map[string]bool{"raised": true}, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("raise = %d", res.StatusCode)
	}
	mertID := s.userID(mert)
	s.call(http.MethodGet, "/api/calls/"+call.ID, ayse, nil, &call)
	raised := 0
	for _, p := range call.Participants {
		if p.HandRaisedAt != nil {
			raised++
			if p.UserID != mertID {
				t.Errorf("raised by %s", p.UserID)
			}
		}
	}
	if raised != 1 {
		t.Errorf("participants = %+v", call.Participants)
	}
	s.call(http.MethodPut, "/api/calls/"+call.ID+"/hand", mert, map[string]bool{"raised": false}, nil)
	s.call(http.MethodGet, "/api/calls/"+call.ID, ayse, nil, &call)
	for _, p := range call.Participants {
		if p.HandRaisedAt != nil {
			t.Errorf("still raised: %+v", p)
		}
	}

	// A reaction reaches the others in the channel, once a second at most.
	conn := s.connect(ayse, "")
	read(t, conn)
	if res := s.call(http.MethodPost, "/api/calls/"+call.ID+"/reactions", mert, map[string]string{"emoji": "👏"}, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("reaction = %d", res.StatusCode)
	}
	ev := readEphemeral(t, conn, "call.reaction")
	var d struct {
		UserID string `json:"user_id"`
		Emoji  string `json:"emoji"`
	}
	_ = json.Unmarshal(ev.Data, &d)
	if d.UserID != mertID || d.Emoji != "👏" {
		t.Errorf("reaction event = %s", ev.Data)
	}
	if status, _ := problemCode(t, s, http.MethodPost, "/api/calls/"+call.ID+"/reactions", mert, map[string]string{"emoji": "🎉"}); status != http.StatusTooManyRequests {
		t.Errorf("second reaction at once = %d", status)
	}
	if status, _ := problemCode(t, s, http.MethodPost, "/api/calls/"+call.ID+"/reactions", ayse, map[string]string{"emoji": "hello"}); status != http.StatusBadRequest {
		t.Errorf("text as reaction = %d", status)
	}
}

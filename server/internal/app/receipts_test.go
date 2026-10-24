// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"encoding/json"
	"net/http"
	"testing"
)

type reads struct {
	Enabled bool `json:"enabled"`
	Reads   []struct {
		UserID     string  `json:"user_id"`
		LastReadID *string `json:"last_read_id"`
	} `json:"reads"`
}

func TestReadReceipts(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	mert := s.user("sub-m", "Mert")
	dm, _ := s.open(ayse, s.defaultWS, s.userID(mert))
	m, _ := s.send(ayse, dm.ID, "okudun mu?", "rr-nonce-1")

	var got reads
	s.call(http.MethodGet, "/api/channels/"+dm.ID+"/reads", ayse, nil, &got)
	if got.Enabled || len(got.Reads) != 0 {
		t.Errorf("off by default: %+v", got)
	}
	if res := s.call(http.MethodPatch, "/api/workspaces/"+s.defaultWS, admin, map[string]bool{"read_receipts": true}, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("turn on = %d", res.StatusCode)
	}

	// Mert reads: Ayşe's devices learn it, and see it when they ask.
	conn := s.connect(ayse, "")
	read(t, conn) // hello
	s.call(http.MethodPost, "/api/channels/"+dm.ID+"/read", mert, map[string]string{"message_id": m.ID}, nil)
	ev := read(t, conn)
	var data struct {
		UserID    string `json:"user_id"`
		MessageID string `json:"message_id"`
	}
	_ = json.Unmarshal(ev.Data, &data)
	if ev.Type != "conversation.read" || data.UserID != s.userID(mert) || data.MessageID != m.ID {
		t.Errorf("event = %s %s", ev.Type, ev.Data)
	}
	s.call(http.MethodGet, "/api/channels/"+dm.ID+"/reads", ayse, nil, &got)
	if !got.Enabled || len(got.Reads) != 1 || got.Reads[0].LastReadID == nil || *got.Reads[0].LastReadID != m.ID {
		t.Errorf("reads = %+v", got)
	}

	// Channels have none.
	var inChannel reads
	s.call(http.MethodGet, "/api/channels/"+s.general(ayse)+"/reads", ayse, nil, &inChannel)
	if inChannel.Enabled {
		t.Errorf("channel reads = %+v", inChannel)
	}

	// Keeping one's own to oneself: others no longer see them, and one sees none.
	if res := s.call(http.MethodPatch, "/api/me/profile", mert, map[string]bool{"share_read_receipts": false}, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("keep = %d", res.StatusCode)
	}
	var after reads
	s.call(http.MethodGet, "/api/channels/"+dm.ID+"/reads", ayse, nil, &after)
	if !after.Enabled || len(after.Reads) != 0 {
		t.Errorf("after keeping: %+v", after)
	}
	var his reads
	s.call(http.MethodGet, "/api/channels/"+dm.ID+"/reads", mert, nil, &his)
	if his.Enabled {
		t.Errorf("mert still sees: %+v", his)
	}
}

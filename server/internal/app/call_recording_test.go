// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/Cenacle-TR/cenacle/server/internal/config"
)

func TestCallRecordingConsent(t *testing.T) {
	shared := newShared(t)
	node := "test-media-rec-" + uuid.NewString()[:8]
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	s := newStack(t, shared, options{calls: &config.Calls{Private: private, KeyID: "test-calls", NodeID: node}})
	ctx := context.Background()
	if err = shared.valkey.PutNew(ctx, "cenacle:media:node:"+node, []byte(uuid.NewString()), time.Minute); err != nil {
		t.Fatal(err)
	}
	admin := s.admin()
	ayse := s.user("rec-a", "Ayşe")
	mert := s.user("rec-m", "Mert")
	zeynep := s.user("rec-z", "Zeynep")
	channel := s.general(ayse)
	if _, err = s.pool.Exec(ctx, "UPDATE workspaces SET calls_enabled = true WHERE id = $1", s.defaultWS); err != nil {
		t.Fatal(err)
	}
	var call struct {
		ID          string  `json:"id"`
		RecordingOn bool    `json:"recording_on"`
		RecordingBy *string `json:"recording_by"`
	}
	s.call(http.MethodPost, "/api/channels/"+channel+"/calls", ayse, map[string]any{"nonce": uuid.NewString()}, &call)
	for _, token := range []string{ayse, mert, zeynep} {
		s.call(http.MethodPost, "/api/calls/"+call.ID+"/token", token, nil, nil)
	}
	if _, err = s.pool.Exec(ctx, "UPDATE call_participants SET state = 'connected', joined_at = now() WHERE call_id = $1", call.ID); err != nil {
		t.Fatal(err)
	}
	path := "/api/calls/" + call.ID + "/recording"
	if status, _ := problemCode(t, s, http.MethodPut, path, ayse, map[string]bool{"on": true}); status != http.StatusForbidden {
		t.Errorf("recording before the workspace allows it = %d", status)
	}
	s.call(http.MethodPut, "/api/workspaces/"+s.defaultWS+"/calls/settings", admin,
		map[string]any{"enabled": true, "guest_start": false, "max_participants": 8, "max_bitrate": 2500000, "recording": true}, nil)

	if res := s.call(http.MethodPut, path, ayse, map[string]bool{"on": true}, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("start = %d", res.StatusCode)
	}
	s.call(http.MethodGet, "/api/calls/"+call.ID, zeynep, nil, &call)
	if !call.RecordingOn || call.RecordingBy == nil || *call.RecordingBy != s.userID(ayse) {
		t.Fatalf("everyone sees the recording: %+v", call)
	}
	// One recorder at a time; anyone in the call may stop it.
	if status, code := problemCode(t, s, http.MethodPut, path, mert, map[string]bool{"on": true}); status != http.StatusConflict || code != "already_recording" {
		t.Errorf("second recorder = %d %s", status, code)
	}
	if res := s.call(http.MethodPut, path, mert, map[string]bool{"on": false}, nil); res.StatusCode != http.StatusNoContent {
		t.Errorf("stop by another = %d", res.StatusCode)
	}
	// The recorder leaving stops it.
	s.call(http.MethodPut, path, ayse, map[string]bool{"on": true}, nil)
	s.call(http.MethodPost, "/api/calls/"+call.ID+"/leave", ayse, nil, nil)
	call.RecordingOn = true
	s.call(http.MethodGet, "/api/calls/"+call.ID, zeynep, nil, &call)
	if call.RecordingOn {
		t.Errorf("recording after the recorder left: %+v", call)
	}
}

// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/Cenacle-TR/cenacle/server/internal/config"
)

func TestLiveCaptions(t *testing.T) {
	// whisper.cpp's server, as far as Cenacle uses it.
	var got struct{ language, file string }
	stt := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/inference" || r.ParseMultipartForm(1<<20) != nil {
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		got.language = r.FormValue("language")
		_, header, _ := r.FormFile("file")
		got.file = header.Filename
		_ = json.NewEncoder(w).Encode(map[string]string{"text": "  Merhaba,   herkese. "})
	}))
	defer stt.Close()

	shared := newShared(t)
	node := "test-media-captions-" + uuid.NewString()[:8]
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	s := newStack(t, shared, options{calls: &config.Calls{Private: private, KeyID: "test-calls", NodeID: node, CaptionsURL: stt.URL}})
	ctx := context.Background()
	if err = shared.valkey.PutNew(ctx, "cenacle:media:node:"+node, []byte(uuid.NewString()), time.Minute); err != nil {
		t.Fatal(err)
	}
	admin := s.admin()
	ayse := s.user("cap-a", "Ayşe")
	mert := s.user("cap-m", "Mert")
	channel := s.general(ayse)
	s.general(mert)
	if _, err = s.pool.Exec(ctx, "UPDATE workspaces SET calls_enabled = true WHERE id = $1", s.defaultWS); err != nil {
		t.Fatal(err)
	}
	var call struct {
		ID         string  `json:"id"`
		CaptionsOn bool    `json:"captions_on"`
		CaptionsBy *string `json:"captions_by"`
	}
	s.call(http.MethodPost, "/api/channels/"+channel+"/calls", ayse, map[string]any{"nonce": uuid.NewString()}, &call)
	for _, token := range []string{ayse, mert} {
		s.call(http.MethodPost, "/api/calls/"+call.ID+"/token", token, nil, nil)
	}
	if _, err = s.pool.Exec(ctx, "UPDATE call_participants SET state = 'connected', joined_at = now() WHERE call_id = $1", call.ID); err != nil {
		t.Fatal(err)
	}
	path := "/api/calls/" + call.ID + "/captions"
	// Off until the workspace allows them.
	if status, _ := problemCode(t, s, http.MethodPut, path, ayse, map[string]bool{"on": true}); status != http.StatusForbidden {
		t.Errorf("captions before the workspace allows them = %d", status)
	}
	var settings map[string]any
	s.call(http.MethodGet, "/api/workspaces/"+s.defaultWS+"/calls/settings", admin, nil, &settings)
	if settings["captions_available"] != true || settings["captions"] != false {
		t.Fatalf("settings = %v", settings)
	}
	input := map[string]any{"enabled": true, "guest_start": false, "max_participants": 8, "max_bitrate": 2500000, "captions": true}
	if res := s.call(http.MethodPut, "/api/workspaces/"+s.defaultWS+"/calls/settings", admin, input, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("allow captions = %d", res.StatusCode)
	}
	// An older client's save keeps captions as they are.
	delete(input, "captions")
	s.call(http.MethodPut, "/api/workspaces/"+s.defaultWS+"/calls/settings", admin, input, &settings)
	if settings["captions"] != true {
		t.Errorf("after an older client's save = %v", settings)
	}

	audioPath := path + "/audio?language=tr"
	send := func(token, kind string) int {
		req, _ := http.NewRequest(http.MethodPost, s.srv.URL+audioPath, bytes.NewReader([]byte("webm-bytes")))
		req.Header.Set("Content-Type", kind)
		req.Header.Set("Authorization", "Bearer "+token)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
		return res.StatusCode
	}
	if status := send(mert, "audio/webm"); status != http.StatusConflict {
		t.Errorf("audio while captions are off = %d", status)
	}
	if res := s.call(http.MethodPut, path, mert, map[string]bool{"on": true}, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("turn on = %d", res.StatusCode)
	}
	s.call(http.MethodGet, "/api/calls/"+call.ID, ayse, nil, &call)
	if !call.CaptionsOn || call.CaptionsBy == nil || *call.CaptionsBy != s.userID(mert) {
		t.Errorf("call = %+v", call)
	}
	conn := s.connect(ayse, "")
	read(t, conn)
	if status := send(mert, "audio/wav"); status != http.StatusBadRequest {
		t.Errorf("wav = %d", status)
	}
	if status := send(mert, "audio/webm"); status != http.StatusNoContent {
		t.Fatalf("audio = %d", status)
	}
	ev := readEphemeral(t, conn, "call.caption")
	var caption struct {
		UserID string `json:"user_id"`
		Text   string `json:"text"`
	}
	_ = json.Unmarshal(ev.Data, &caption)
	if caption.UserID != s.userID(mert) || caption.Text != "Merhaba, herkese." || got.language != "tr" || got.file != "audio.webm" {
		t.Errorf("caption = %+v, service got %+v", caption, got)
	}
}

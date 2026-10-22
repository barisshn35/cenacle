// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/barisshn35/cenacle/server/internal/ai"
	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/chat"
)

// fakeModel is an OpenAI-compatible server that answers "ok: <n> lines" and
// keeps what it was asked.
type fakeModel struct {
	mu    sync.Mutex
	asked []string
	fail  bool
}

func (f *fakeModel) serve(t *testing.T) *ai.Client {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Model    string `json:"model"`
			Messages []struct{ Role, Content string }
		}
		if r.URL.Path != "/v1/chat/completions" || json.NewDecoder(r.Body).Decode(&in) != nil || in.Model != "tiny" {
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		f.mu.Lock()
		f.asked = append(f.asked, in.Messages[1].Content)
		fail := f.fail
		f.mu.Unlock()
		if fail {
			http.Error(w, "down", http.StatusInternalServerError)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{
			"message": map[string]string{"role": "assistant", "content": "- summary of " + in.Messages[1].Content[:min(20, len(in.Messages[1].Content))]},
		}}})
	}))
	t.Cleanup(srv.Close)
	return ai.New(srv.URL+"/v1", "tiny", "", 5*time.Second)
}

func (f *fakeModel) last() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.asked) == 0 {
		return ""
	}
	return f.asked[len(f.asked)-1]
}

func TestAIOffByDefault(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	var session struct{ Permissions api.Permissions }
	s.call(http.MethodGet, "/api/session", admin, nil, &session)
	if session.Permissions.Ai == nil || *session.Permissions.Ai {
		t.Errorf("ai permission without a model = %v", session.Permissions.Ai)
	}
	general := s.general(admin)
	if status, code := problemCode(t, s, http.MethodPost, "/api/channels/"+general+"/ai/summary", admin, map[string]any{}); status != http.StatusNotFound || code != chat.CodeAIOff {
		t.Errorf("summary without a model = %d %s", status, code)
	}
}

func TestAISummaryComposeAndAsk(t *testing.T) {
	model := &fakeModel{}
	s := newStack(t, newShared(t), options{ai: model.serve(t)})
	admin := s.admin()
	ayse := s.user("sub-ayse", "Ayşe")
	general := s.general(ayse)
	s.send(ayse, general, "We ship the release on Friday", "ai-nonce-1")
	s.send(admin, general, "Mert writes the release notes", "ai-nonce-2")
	var secret channel
	s.call(http.MethodPost, "/api/channels", admin, map[string]any{"name": "Board", "visibility": "private"}, &secret)
	s.send(admin, secret.ID, "The release budget is secret", "ai-nonce-3")

	// Off until the workspace turns it on.
	summary := "/api/channels/" + general + "/ai/summary"
	if status, code := problemCode(t, s, http.MethodPost, summary, ayse, map[string]any{}); status != http.StatusForbidden || code != chat.CodeAIOff {
		t.Fatalf("summary before turning on = %d %s", status, code)
	}
	aiPath := "/api/workspaces/" + s.defaultWS + "/ai"
	if status, _ := problemCode(t, s, http.MethodPut, aiPath, ayse, map[string]any{"enabled": true}); status != http.StatusForbidden {
		t.Errorf("member turns on ai = %d", status)
	}
	var ws api.Workspace
	if res := s.call(http.MethodPut, aiPath, admin, map[string]any{"enabled": true}, &ws); res.StatusCode != http.StatusOK || ws.AiEnabled == nil || !*ws.AiEnabled {
		t.Fatalf("turn on = %d %+v", res.StatusCode, ws.AiEnabled)
	}

	var answer api.AIAnswer
	if res := s.call(http.MethodPost, summary, ayse, map[string]any{"language": "tr"}, &answer); res.StatusCode != http.StatusOK || !strings.HasPrefix(answer.Text, "- summary") {
		t.Fatalf("summary = %d %q", res.StatusCode, answer.Text)
	}
	asked := model.last()
	if !strings.Contains(asked, "Ayşe: We ship the release on Friday") || strings.Index(asked, "Friday") > strings.Index(asked, "Mert writes") {
		t.Errorf("transcript = %q", asked)
	}

	if res := s.call(http.MethodPost, "/api/workspaces/"+s.defaultWS+"/ai/compose", ayse, map[string]any{"text": "pls ship it frday", "action": "improve"}, &answer); res.StatusCode != http.StatusOK || model.last() != "pls ship it frday" {
		t.Errorf("compose = %d, asked %q", res.StatusCode, model.last())
	}
	if status, _ := problemCode(t, s, http.MethodPost, "/api/workspaces/"+s.defaultWS+"/ai/compose", ayse, map[string]any{"text": "hi", "action": "translate"}); status != http.StatusBadRequest {
		t.Errorf("translate without a language = %d", status)
	}

	// Ask uses only what the asker can read.
	if res := s.call(http.MethodPost, "/api/workspaces/"+s.defaultWS+"/ai/ask", ayse, map[string]any{"question": "When is the release?"}, &answer); res.StatusCode != http.StatusOK {
		t.Fatalf("ask = %d", res.StatusCode)
	}
	if len(answer.Sources) != 2 || strings.Contains(model.last(), "budget") {
		t.Errorf("ask sources = %d, asked %q", len(answer.Sources), model.last())
	}

	// The model failing is a 502, not a crash; limits apply per person.
	model.mu.Lock()
	model.fail = true
	model.mu.Unlock()
	if status, code := problemCode(t, s, http.MethodPost, summary, ayse, map[string]any{}); status != http.StatusBadGateway || code != chat.CodeAIFailed {
		t.Errorf("model down = %d %s", status, code)
	}
	if n := s.count(`SELECT count(*) FROM ai_requests`); n != 3 {
		t.Errorf("recorded requests = %d, want 3", n)
	}
}

// SPDX-License-Identifier: Apache-2.0

package app_test

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

type bot struct {
	ID       string `json:"id"`
	UserID   string `json:"user_id"`
	Name     string `json:"name"`
	Disabled bool   `json:"disabled"`
}

// raw posts a body as is (webhooks take any JSON; no session).
func (s *stack) raw(method, url, token, body string) *http.Response {
	s.t.Helper()
	req, _ := http.NewRequest(method, url, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := s.client.Do(req)
	if err != nil {
		s.t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, res.Body)
	_ = res.Body.Close()
	return res
}

func TestBotsTokensAndWebhooks(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	general := s.general(ayse)
	bots := "/api/workspaces/" + s.defaultWS + "/bots"

	if status, _ := problemCode(t, s, http.MethodPost, bots, ayse, map[string]string{"name": "Jira"}); status != http.StatusForbidden {
		t.Errorf("member creating a bot = %d", status)
	}
	var b bot
	if res := s.call(http.MethodPost, bots, admin, map[string]string{"name": "Jira", "description": "Issues"}, &b); res.StatusCode != http.StatusCreated {
		t.Fatalf("create bot = %d", res.StatusCode)
	}

	// A write token; the bot joins General like a person.
	var created struct {
		Secret string `json:"secret"`
	}
	s.call(http.MethodPost, "/api/bots/"+b.ID+"/tokens", admin, map[string]any{"name": "ci", "scopes": []string{"messages:write", "messages:read"}}, &created)
	if !strings.HasPrefix(created.Secret, "cnb_") {
		t.Fatalf("secret = %q", created.Secret)
	}
	token := created.Secret
	if _, res := s.send(token, general, "not a member yet", "bot-nonce-0"); res.StatusCode != http.StatusForbidden {
		t.Errorf("posting outside its channels = %d", res.StatusCode)
	}
	s.call(http.MethodPost, "/api/channels/"+general+"/members", admin, map[string]string{"user_id": b.UserID}, nil)
	conn := s.connect(ayse, "")
	read(t, conn)
	m, res := s.send(token, general, "**Derleme** tamam", "bot-nonce-1")
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("bot message = %d", res.StatusCode)
	}
	ev := read(t, conn)
	if ev.Type != "message.created" || !strings.Contains(string(ev.Data), `"is_bot":true`) || !strings.Contains(string(ev.Data), m.ID) {
		t.Errorf("event = %s %s", ev.Type, ev.Data)
	}

	// Bots reach only the bot API, within their scopes.
	for _, path := range []string{"/api/session", "/api/workspaces", "/api/sessions"} {
		if status, code := problemCode(t, s, http.MethodGet, path, token, nil); status != http.StatusForbidden || code != "bot_not_allowed" {
			t.Errorf("bot GET %s = %d %s", path, status, code)
		}
	}
	var readOnly struct{ Secret string }
	s.call(http.MethodPost, "/api/bots/"+b.ID+"/tokens", admin, map[string]any{"name": "ro", "scopes": []string{"messages:read"}}, &readOnly)
	if _, res := s.send(readOnly.Secret, general, "x", "bot-nonce-2"); res.StatusCode != http.StatusForbidden {
		t.Errorf("read-only token posting = %d", res.StatusCode)
	}
	if res := s.call(http.MethodGet, "/api/channels/"+general+"/messages", readOnly.Secret, nil, nil); res.StatusCode != http.StatusOK {
		t.Errorf("read-only token reading = %d", res.StatusCode)
	}

	// A generic and a Jira webhook into General.
	var generic, jiraHook struct {
		URL string `json:"url"`
	}
	s.call(http.MethodPost, "/api/bots/"+b.ID+"/webhooks", admin, map[string]string{"name": "Alarm", "channel_id": general, "kind": "generic"}, &generic)
	s.call(http.MethodPost, "/api/bots/"+b.ID+"/webhooks", admin, map[string]string{"name": "Jira", "channel_id": general, "kind": "jira"}, &jiraHook)
	if !strings.HasPrefix(generic.URL, s.srv.URL+"/api/hooks/cnh_") {
		t.Fatalf("webhook url = %q", generic.URL)
	}
	if res := s.raw(http.MethodPost, generic.URL, "", `{"text": "Disk **%90** dolu"}`); res.StatusCode != http.StatusOK {
		t.Fatalf("generic hook = %d", res.StatusCode)
	}
	jiraEvent := `{"webhookEvent": "jira:issue_created", "user": {"displayName": "Ayşe"},
	  "issue": {"key": "CEN-7", "self": "https://acme.atlassian.net/rest/api/2/issue/1", "fields": {"summary": "Giriş"}}}`
	if res := s.raw(http.MethodPost, jiraHook.URL, "", jiraEvent); res.StatusCode != http.StatusOK {
		t.Fatalf("jira hook = %d", res.StatusCode)
	}
	if res := s.raw(http.MethodPost, jiraHook.URL, "", `{"webhookEvent": "worklog_created", "issue": {"key": "CEN-7"}}`); res.StatusCode != http.StatusOK {
		t.Errorf("ignored jira event = %d", res.StatusCode)
	}
	page := s.page(ayse, general)
	last := page[len(page)-1]
	if len(page) < 3 || page[len(page)-2].Body != "Disk **%90** dolu" || last.Attachments[0]["title"] != "CEN-7: Giriş" {
		t.Errorf("posted = %+v", page)
	}
	if res := s.raw(http.MethodPost, generic.URL, "", `not json`); res.StatusCode != http.StatusBadRequest {
		t.Errorf("garbage = %d", res.StatusCode)
	}
	if res := s.raw(http.MethodPost, s.srv.URL+"/api/hooks/cnh_wrongwrongwrongwrongwrong", "", `{"text":"x"}`); res.StatusCode != http.StatusNotFound {
		t.Errorf("unknown hook = %d", res.StatusCode)
	}

	// Disabling the bot stops its tokens and webhooks; enabling brings them back.
	s.call(http.MethodPatch, "/api/bots/"+b.ID, admin, map[string]bool{"disabled": true}, nil)
	if _, res := s.send(token, general, "x", "bot-nonce-3"); res.StatusCode != http.StatusUnauthorized {
		t.Errorf("disabled bot token = %d", res.StatusCode)
	}
	if res := s.raw(http.MethodPost, generic.URL, "", `{"text":"x"}`); res.StatusCode != http.StatusNotFound {
		t.Errorf("disabled bot webhook = %d", res.StatusCode)
	}
	s.call(http.MethodPatch, "/api/bots/"+b.ID, admin, map[string]bool{"disabled": false}, nil)
	if res := s.raw(http.MethodPost, generic.URL, "", `{"text":"geri döndüm"}`); res.StatusCode != http.StatusOK {
		t.Errorf("enabled bot webhook = %d", res.StatusCode)
	}

	// Revoked tokens stop at once.
	var tokens struct {
		Tokens []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"tokens"`
	}
	s.call(http.MethodGet, "/api/bots/"+b.ID+"/tokens", admin, nil, &tokens)
	for _, tk := range tokens.Tokens {
		if tk.Name == "ci" {
			s.call(http.MethodDelete, "/api/bots/"+b.ID+"/tokens/"+tk.ID, admin, nil, nil)
		}
	}
	if _, res := s.send(token, general, "x", "bot-nonce-4"); res.StatusCode != http.StatusUnauthorized {
		t.Errorf("revoked token = %d", res.StatusCode)
	}
	// The bot is marked in member lists and audited.
	var people struct {
		Users []struct {
			DisplayName string `json:"display_name"`
			IsBot       bool   `json:"is_bot"`
		} `json:"users"`
	}
	s.call(http.MethodGet, "/api/users?q=jira", admin, nil, &people)
	if len(people.Users) != 1 || !people.Users[0].IsBot {
		t.Errorf("search = %+v", people.Users)
	}
}

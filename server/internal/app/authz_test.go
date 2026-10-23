// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"slices"
	"sort"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

// TestOutsidersReachNothing calls every operation of the API that names a
// resource, with the resources of a workspace the caller is not in. None may
// succeed (2xx) and none may fail on the server (5xx): an outsider learns
// nothing and breaks nothing.
func TestOutsidersReachNothing(t *testing.T) {
	s := newStack(t, newShared(t), options{files: true})
	admin := s.admin()
	outsider := s.user("sub-outsider", "Outsider")
	ws := s.newWorkspace(admin, "Secret")

	id := func(path string, body any, key string) string {
		t.Helper()
		var out map[string]any
		if res := s.call(http.MethodPost, path, admin, body, &out); res.StatusCode >= 300 {
			t.Fatalf("setup %s = %d", path, res.StatusCode)
		}
		v, _ := out[key].(string)
		return v
	}
	private := id("/api/channels", map[string]any{"name": "vault", "visibility": "private", "workspace_id": ws}, "id")
	public := id("/api/channels", map[string]any{"name": "lobby", "workspace_id": ws}, "id")
	msg, _ := s.send(admin, private, "secret plans", "authz-nonce-1")
	canvasTab := id("/api/channels/"+private+"/tabs", map[string]any{"kind": "canvas", "title": "Plan"}, "id")
	listTab := map[string]any{}
	s.call(http.MethodPost, "/api/channels/"+private+"/tabs", admin, map[string]any{"kind": "list", "title": "Tasks"}, &listTab)
	listID, _ := listTab["list_id"].(string)
	item := id("/api/lists/"+listID+"/items", map[string]any{"title": "Do it"}, "id")
	var canvas map[string]any
	s.call(http.MethodGet, "/api/channels/"+private+"/tabs", admin, nil, &canvas)
	form := id("/api/workspaces/"+ws+"/forms", map[string]any{"name": "F", "fields": []map[string]any{{"id": "a", "label": "A", "kind": "text", "required": false}}}, "id")
	workflow := id("/api/workspaces/"+ws+"/workflows", map[string]any{"name": "W", "enabled": true, "trigger": map[string]any{"kind": "manual"},
		"steps": []map[string]any{{"id": "s1", "kind": "message", "text": "hi", "channel_id": public}}}, "id")
	bot := id("/api/workspaces/"+ws+"/bots", map[string]any{"name": "Robot"}, "id")
	hold := id("/api/workspaces/"+ws+"/legal-holds", map[string]any{"name": "Case", "user_ids": []string{}, "channel_ids": []string{private}}, "id")
	category := id("/api/categories", map[string]any{"name": "Cat", "workspace_id": ws}, "id")
	var tabs struct {
		Tabs []map[string]any `json:"tabs"`
	}
	s.call(http.MethodGet, "/api/channels/"+private+"/tabs", admin, nil, &tabs)
	canvasID := ""
	for _, tab := range tabs.Tabs {
		if c, ok := tab["canvas_id"].(string); ok {
			canvasID = c
		}
	}
	unknown := "01a10000-0000-7000-8000-00000000dead"
	values := map[string]string{
		"workspace_id": ws, "channel_id": private, "message_id": msg.ID, "root_id": msg.ID,
		"tab_id": canvasTab, "canvas_id": canvasID, "list_id": listID, "item_id": item,
		"form_id": form, "workflow_id": workflow, "bot_id": bot, "hold_id": hold, "category_id": category,
		"emoji": "%F0%9F%91%8D", "group": "staff",
	}

	raw, err := os.ReadFile("../../api/openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	var spec struct {
		Paths map[string]map[string]any `yaml:"paths"`
	}
	if err := yaml.Unmarshal(raw, &spec); err != nil {
		t.Fatal(err)
	}
	// Open to anyone by design (they check a token or a signature instead), or
	// about the caller only (/api/me).
	public2 := regexp.MustCompile(`^/api/(hooks|workflow-hooks|federation/v1|invites|pictures|auth|ws|me)/`)
	// Only about the caller (or other people, whom workspaces share).
	self := regexp.MustCompile(`\{(user_id|token|session_id|sound_id|font_id|scheduled_id|picture_id|token_id|invite_id)\}`)
	param := regexp.MustCompile(`\{([a-z_]+)\}`)
	var paths []string
	for p := range spec.Paths {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	probe := func(caller string, include func(path string) bool) (checked int, leaks, crashes []string) {
		for _, p := range paths {
			if !strings.Contains(p, "{") || public2.MatchString(p) || self.MatchString(p) || !include(p) {
				continue
			}
			for method := range spec.Paths[p] {
				method = strings.ToUpper(method)
				if !slices.Contains([]string{"GET", "POST", "PUT", "PATCH", "DELETE"}, method) {
					continue
				}
				target := param.ReplaceAllStringFunc(p, func(m string) string {
					if v := values[strings.Trim(m, "{}")]; v != "" {
						return v
					}
					return unknown
				})
				var body io.Reader
				if method != "GET" && method != "DELETE" {
					body = bytes.NewReader([]byte(`{}`))
				}
				req, _ := http.NewRequest(method, s.srv.URL+target, body)
				req.Header.Set("Authorization", "Bearer "+caller)
				req.Header.Set("Content-Type", "application/json")
				res, err := s.client.Do(req)
				if err != nil {
					t.Fatal(err)
				}
				b, _ := io.ReadAll(res.Body)
				_ = res.Body.Close()
				checked++
				line := fmt.Sprintf("%s %s = %d %s", method, p, res.StatusCode, strings.TrimSpace(string(b[:min(len(b), 160)])))
				switch {
				case res.StatusCode >= 500:
					crashes = append(crashes, line)
				case res.StatusCode < 300:
					leaks = append(leaks, line)
				}
			}
		}
		return checked, leaks, crashes
	}
	checked, leaks, crashes := probe(outsider, func(string) bool { return true })
	if checked < 100 {
		t.Fatalf("only %d operations checked", checked)
	}
	for _, l := range leaks {
		t.Errorf("outsider succeeded: %s", l)
	}
	for _, c := range crashes {
		t.Errorf("server error: %s", c)
	}

	// A member of the workspace who is not in the private channel reaches
	// nothing of that channel either.
	insider := s.user("sub-insider", "Insider")
	token := s.invite(admin, ws, map[string]any{})
	if res := s.call(http.MethodPost, "/api/invites/"+token+"/accept", insider, nil, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("insider joins = %d", res.StatusCode)
	}
	channelScoped := regexp.MustCompile(`\{(channel_id|message_id|root_id|tab_id|canvas_id|list_id|item_id)\}`)
	n, leaks, crashes := probe(insider, channelScoped.MatchString)
	if n < 40 {
		t.Fatalf("only %d channel operations checked", n)
	}
	for _, l := range leaks {
		t.Errorf("insider outside the channel succeeded: %s", l)
	}
	for _, c := range crashes {
		t.Errorf("server error (insider): %s", c)
	}
}

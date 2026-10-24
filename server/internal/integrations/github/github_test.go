// SPDX-License-Identifier: AGPL-3.0-only

package github

import (
	"strings"
	"testing"
)

func TestCards(t *testing.T) {
	repo := `"repository":{"full_name":"acme/api","html_url":"https://github.com/acme/api"},"sender":{"login":"ayse"}`
	for _, c := range []struct {
		kind, body, title, color string
		posted                   bool
	}{
		{"push", `{"ref":"refs/heads/main","compare":"https://github.com/acme/api/compare/a...b","commits":[{"id":"0123456789","message":"Fix login\n\nlong"}],` + repo + `}`, "ayse pushed to main", "neutral", true},
		{"push", `{"ref":"refs/heads/x","commits":[],` + repo + `}`, "", "", false},
		{"pull_request", `{"action":"closed","pull_request":{"number":7,"title":"Add SSO","html_url":"https://github.com/acme/api/pull/7","merged":true,"head":{"ref":"sso"},"base":{"ref":"main"}},` + repo + `}`, "#7 Add SSO", "success", true},
		{"pull_request", `{"action":"labeled","pull_request":{"number":7},` + repo + `}`, "", "", false},
		{"pull_request_review", `{"action":"submitted","review":{"state":"changes_requested","body":"Tests?"},"pull_request":{"number":7,"title":"Add SSO"},` + repo + `}`, "#7 Add SSO", "warning", true},
		{"issues", `{"action":"opened","issue":{"number":3,"title":"Crash","html_url":"https://github.com/acme/api/issues/3"},` + repo + `}`, "#3 Crash", "info", true},
		{"issue_comment", `{"action":"created","issue":{"number":3,"title":"Crash"},"comment":{"body":"Same here"},` + repo + `}`, "#3 Crash", "neutral", true},
		{"workflow_run", `{"action":"completed","workflow_run":{"name":"CI","conclusion":"failure","head_branch":"main","run_number":42},` + repo + `}`, "CI #42 failure", "danger", true},
		{"workflow_run", `{"action":"requested","workflow_run":{"name":"CI"},` + repo + `}`, "", "", false},
		{"release", `{"action":"published","release":{"tag_name":"v1.0","name":"","html_url":"https://github.com/acme/api/releases/v1.0"},` + repo + `}`, "Released v1.0", "success", true},
		{"ping", `{` + repo + `}`, "Connected to acme/api", "success", true},
		{"star", `{` + repo + `}`, "", "", false},
	} {
		card, ok, err := Card(c.kind, []byte(c.body))
		if err != nil || ok != c.posted {
			t.Errorf("%s: ok=%v err=%v", c.kind, ok, err)
			continue
		}
		if !ok {
			continue
		}
		if card.Title == nil || *card.Title != c.title || string(*card.Color) != c.color || !strings.HasSuffix(*card.Footer, "acme/api") {
			t.Errorf("%s: %+v", c.kind, card)
		}
	}
	if _, _, err := Card("push", []byte("not json")); err == nil {
		t.Error("garbage accepted")
	}
}

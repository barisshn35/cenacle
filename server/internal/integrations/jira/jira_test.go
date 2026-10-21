// SPDX-License-Identifier: Apache-2.0

package jira_test

import (
	"strings"
	"testing"

	"github.com/barisshn35/cenacle/server/internal/integrations/jira"
)

const issue = `"issue": {"key": "CEN-42", "self": "https://acme.atlassian.net/rest/api/2/issue/10042",
  "fields": {"summary": "Giriş sayfası açılmıyor", "issuetype": {"name": "Bug"},
    "status": {"name": "In Progress"}, "priority": {"name": "High"}, "assignee": {"displayName": "Mert Kaya"}}}`

func TestCards(t *testing.T) {
	created, ok, err := jira.Card([]byte(`{"webhookEvent": "jira:issue_created", "user": {"displayName": "Ayşe"}, ` + issue + `}`))
	if err != nil || !ok {
		t.Fatalf("created: %v %v", ok, err)
	}
	if *created.Title != "CEN-42: Giriş sayfası açılmıyor" || *created.TitleLink != "https://acme.atlassian.net/browse/CEN-42" ||
		*created.Color != "info" || *created.Text != "Ayşe created this bug." || len(*created.Fields) != 3 {
		t.Errorf("created card = %+v", created)
	}

	updated, ok, _ := jira.Card([]byte(`{"webhookEvent": "jira:issue_updated", "user": {"displayName": "Mert"}, ` + issue +
		`, "changelog": {"items": [{"field": "description", "fromString": "a", "toString": "b"},
		{"field": "status", "fromString": "Open", "toString": "In Progress"}]}}`))
	if !ok || !strings.Contains(*updated.Text, "**status**: Open → In Progress") || strings.Contains(*updated.Text, "description") {
		t.Errorf("updated card = %+v", updated)
	}

	// Changes nobody needs to hear about are not posted.
	if _, ok, _ := jira.Card([]byte(`{"webhookEvent": "jira:issue_updated", ` + issue +
		`, "changelog": {"items": [{"field": "description"}]}}`)); ok {
		t.Error("a description change was posted")
	}
	comment, ok, _ := jira.Card([]byte(`{"webhookEvent": "comment_created", ` + issue +
		`, "comment": {"body": "Bakıyorum.\nYarın.", "author": {"displayName": "Zeynep"}}}`))
	if !ok || *comment.Text != "Zeynep commented.\n\n> Bakıyorum.\n> Yarın." {
		t.Errorf("comment card = %q", *comment.Text)
	}
	if _, ok, _ := jira.Card([]byte(`{"webhookEvent": "worklog_created", ` + issue + `}`)); ok {
		t.Error("an unknown event was posted")
	}
	if _, _, err := jira.Card([]byte(`not json`)); err == nil {
		t.Error("garbage accepted")
	}
	// A link only to http(s) addresses.
	odd, _, _ := jira.Card([]byte(`{"webhookEvent": "jira:issue_created", "issue": {"key": "X-1", "self": "javascript:alert(1)/rest/x", "fields": {}}}`))
	if odd.TitleLink != nil {
		t.Errorf("link = %q", *odd.TitleLink)
	}
}

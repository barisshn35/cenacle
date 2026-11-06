// SPDX-License-Identifier: AGPL-3.0-only

package gitlab_test

import (
	"strings"
	"testing"

	"github.com/Cenacle-TR/cenacle/server/internal/integrations/gitlab"
)

const project = `"project": {"path_with_namespace": "acme/web", "web_url": "https://gitlab.example.com/acme/web"}`

func TestCards(t *testing.T) {
	push, ok, err := gitlab.Card([]byte(`{"object_kind": "push", "user_name": "Ayşe", "ref": "refs/heads/main", ` + project + `,
	  "total_commits_count": 1, "commits": [{"id": "0123456789abcdef", "message": "Fix login\n\nlong text"}]}`))
	if err != nil || !ok || *push.Title != "Ayşe pushed to main" || !strings.Contains(*push.Text, "`01234567` Fix login") {
		t.Errorf("push = %+v %v %v", push, ok, err)
	}
	mr, ok, _ := gitlab.Card([]byte(`{"object_kind": "merge_request", "user": {"name": "Mert"}, ` + project + `,
	  "object_attributes": {"iid": 7, "title": "Dark theme", "url": "https://gitlab.example.com/acme/web/-/merge_requests/7",
	  "action": "merge", "source_branch": "dark", "target_branch": "main"}}`))
	if !ok || *mr.Title != "!7 Dark theme" || *mr.Color != "success" || *mr.Text != "Mert merged the merge request." {
		t.Errorf("mr = %+v", mr)
	}
	failed, ok, _ := gitlab.Card([]byte(`{"object_kind": "pipeline", ` + project + `, "object_attributes": {"id": 42, "status": "failed", "ref": "main", "duration": 93}}`))
	if !ok || *failed.Color != "danger" || *failed.TitleLink != "https://gitlab.example.com/acme/web/-/pipelines/42" {
		t.Errorf("pipeline = %+v", failed)
	}
	if _, ok, _ := gitlab.Card([]byte(`{"object_kind": "pipeline", "object_attributes": {"status": "running"}}`)); ok {
		t.Error("a running pipeline was posted")
	}
	if _, ok, _ := gitlab.Card([]byte(`{"object_kind": "wiki_page"}`)); ok {
		t.Error("an unknown event was posted")
	}
	if _, _, err := gitlab.Card([]byte(`x`)); err == nil {
		t.Error("garbage accepted")
	}
}

// SPDX-License-Identifier: AGPL-3.0-only

// Package gitlab turns GitLab webhook events into message cards: pushes,
// merge requests, pipelines, issues and comments.
package gitlab

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/integrations"
)

type user struct {
	Name     string `json:"name"`
	Username string `json:"username"`
}

type event struct {
	ObjectKind string `json:"object_kind"`
	UserName   string `json:"user_name"`
	User       *user  `json:"user"`
	Ref        string `json:"ref"`
	Project    struct {
		PathWithNamespace string `json:"path_with_namespace"`
		WebURL            string `json:"web_url"`
	} `json:"project"`
	Commits []struct {
		ID      string `json:"id"`
		Message string `json:"message"`
		URL     string `json:"url"`
		Author  struct {
			Name string `json:"name"`
		} `json:"author"`
	} `json:"commits"`
	TotalCommits     int `json:"total_commits_count"`
	ObjectAttributes struct {
		IID          int    `json:"iid"`
		Title        string `json:"title"`
		URL          string `json:"url"`
		Action       string `json:"action"`
		State        string `json:"state"`
		Status       string `json:"status"`
		Ref          string `json:"ref"`
		SourceBranch string `json:"source_branch"`
		TargetBranch string `json:"target_branch"`
		Note         string `json:"note"`
		NoteableType string `json:"noteable_type"` //nolint:misspell // GitLab's field name
		ID           int64  `json:"id"`
		Duration     *int   `json:"duration"`
	} `json:"object_attributes"`
	MergeRequest *struct {
		IID   int    `json:"iid"`
		Title string `json:"title"`
	} `json:"merge_request"`
	Issue *struct {
		IID   int    `json:"iid"`
		Title string `json:"title"`
	} `json:"issue"`
}

func (e event) actor() string {
	if e.User != nil && e.User.Name != "" {
		return e.User.Name
	}
	if e.UserName != "" {
		return e.UserName
	}
	return "Someone"
}

// Card describes an event; ok is false for events that are not posted.
func Card(payload []byte) (api.Attachment, bool, error) {
	var e event
	if err := json.Unmarshal(payload, &e); err != nil {
		return api.Attachment{}, false, fmt.Errorf("not a GitLab event: %w", err)
	}
	project := e.Project.PathWithNamespace
	a := e.ObjectAttributes
	switch e.ObjectKind {
	case "push":
		if len(e.Commits) == 0 {
			return api.Attachment{}, false, nil // branch created or deleted
		}
		branch := strings.TrimPrefix(e.Ref, "refs/heads/")
		var lines []string
		for i, c := range e.Commits {
			if i == 5 {
				lines = append(lines, fmt.Sprintf("… and %d more", e.TotalCommits-5))
				break
			}
			title, _, _ := strings.Cut(c.Message, "\n")
			short := c.ID
			if len(short) > 8 {
				short = short[:8]
			}
			lines = append(lines, fmt.Sprintf("`%s` %s", short, integrations.Truncate(title, 100)))
		}
		return integrations.Card(fmt.Sprintf("%s pushed to %s", e.actor(), branch), e.Project.WebURL,
			strings.Join(lines, "\n"), "neutral", "GitLab · "+project, nil), true, nil
	case "merge_request":
		color := api.AttachmentColor("info")
		switch a.Action {
		case "merge":
			color = "success"
		case "close":
			color = "neutral"
		case "open", "reopen", "update", "approved":
		default:
			return api.Attachment{}, false, nil
		}
		return integrations.Card(fmt.Sprintf("!%d %s", a.IID, a.Title), a.URL,
			fmt.Sprintf("%s %s the merge request.", e.actor(), verb(a.Action)), color, "GitLab · "+project,
			[]integrations.Field{integrations.ShortField("Branches", a.SourceBranch+" → "+a.TargetBranch)}), true, nil
	case "pipeline":
		var color api.AttachmentColor
		switch a.Status {
		case "success":
			color = "success"
		case "failed":
			color = "danger"
		case "canceled":
			color = "neutral"
		default:
			return api.Attachment{}, false, nil // running, pending: wait for the outcome
		}
		fields := []integrations.Field{integrations.ShortField("Branch", a.Ref), integrations.ShortField("Status", a.Status)}
		if a.Duration != nil {
			fields = append(fields, integrations.ShortField("Duration", fmt.Sprintf("%ds", *a.Duration)))
		}
		link := ""
		if e.Project.WebURL != "" {
			link = fmt.Sprintf("%s/-/pipelines/%d", e.Project.WebURL, a.ID)
		}
		return integrations.Card(fmt.Sprintf("Pipeline #%d %s", a.ID, a.Status), link, "", color,
			"GitLab · "+project, fields), true, nil
	case "issue":
		switch a.Action {
		case "open", "close", "reopen":
		default:
			return api.Attachment{}, false, nil
		}
		color := api.AttachmentColor("info")
		if a.Action == "close" {
			color = "neutral"
		}
		return integrations.Card(fmt.Sprintf("#%d %s", a.IID, a.Title), a.URL,
			fmt.Sprintf("%s %s the issue.", e.actor(), verb(a.Action)), color, "GitLab · "+project, nil), true, nil
	case "note":
		target := "a comment"
		switch {
		case e.MergeRequest != nil:
			target = fmt.Sprintf("!%d %s", e.MergeRequest.IID, e.MergeRequest.Title)
		case e.Issue != nil:
			target = fmt.Sprintf("#%d %s", e.Issue.IID, e.Issue.Title)
		}
		text := e.actor() + " commented.\n\n> " + strings.ReplaceAll(integrations.Truncate(a.Note, 500), "\n", "\n> ")
		return integrations.Card(target, a.URL, text, "neutral", "GitLab · "+project, nil), true, nil
	}
	return api.Attachment{}, false, nil
}

func verb(action string) string {
	switch action {
	case "open":
		return "opened"
	case "reopen":
		return "reopened"
	case "close":
		return "closed"
	case "merge":
		return "merged"
	case "approved":
		return "approved"
	default:
		return "updated"
	}
}

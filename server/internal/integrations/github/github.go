// SPDX-License-Identifier: AGPL-3.0-only

// Package github turns GitHub webhook events into message cards: pushes, pull
// requests, reviews, issues, comments, workflow runs and releases. GitHub names
// the event in the X-GitHub-Event header.
package github

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/integrations"
)

type user struct {
	Login string `json:"login"`
}

type event struct {
	Action string `json:"action"`
	Ref    string `json:"ref"`
	Sender user   `json:"sender"`
	Repo   struct {
		FullName string `json:"full_name"`
		HTMLURL  string `json:"html_url"`
	} `json:"repository"`
	Compare string `json:"compare"`
	Commits []struct {
		ID      string `json:"id"`
		Message string `json:"message"`
	} `json:"commits"`
	PullRequest *struct {
		Number  int    `json:"number"`
		Title   string `json:"title"`
		HTMLURL string `json:"html_url"`
		Merged  bool   `json:"merged"`
		Head    struct {
			Ref string `json:"ref"`
		} `json:"head"`
		Base struct {
			Ref string `json:"ref"`
		} `json:"base"`
	} `json:"pull_request"`
	Review *struct {
		State   string `json:"state"`
		HTMLURL string `json:"html_url"`
		Body    string `json:"body"`
	} `json:"review"`
	Issue *struct {
		Number  int    `json:"number"`
		Title   string `json:"title"`
		HTMLURL string `json:"html_url"`
	} `json:"issue"`
	Comment *struct {
		Body    string `json:"body"`
		HTMLURL string `json:"html_url"`
	} `json:"comment"`
	WorkflowRun *struct {
		Name       string `json:"name"`
		Conclusion string `json:"conclusion"`
		HeadBranch string `json:"head_branch"`
		HTMLURL    string `json:"html_url"`
		RunNumber  int    `json:"run_number"`
	} `json:"workflow_run"`
	Release *struct {
		TagName string `json:"tag_name"`
		Name    string `json:"name"`
		HTMLURL string `json:"html_url"`
	} `json:"release"`
}

func quote(s string) string {
	return "> " + strings.ReplaceAll(integrations.Truncate(strings.TrimSpace(s), 500), "\n", "\n> ")
}

// Card describes an event (named by X-GitHub-Event); ok is false for events
// that are not posted.
func Card(kind string, payload []byte) (api.Attachment, bool, error) {
	var e event
	if err := json.Unmarshal(payload, &e); err != nil {
		return api.Attachment{}, false, fmt.Errorf("not a GitHub event: %w", err)
	}
	repo := e.Repo.FullName
	footer := "GitHub · " + repo
	who := e.Sender.Login
	if who == "" {
		who = "Someone"
	}
	switch kind {
	case "ping":
		return integrations.Card("Connected to "+repo, e.Repo.HTMLURL, "GitHub will send this repository's events here.",
			"success", footer, nil), true, nil
	case "push":
		if len(e.Commits) == 0 {
			return api.Attachment{}, false, nil // a branch or tag created or deleted
		}
		var lines []string
		for i, c := range e.Commits {
			if i == 5 {
				lines = append(lines, fmt.Sprintf("… and %d more", len(e.Commits)-5))
				break
			}
			title, _, _ := strings.Cut(c.Message, "\n")
			short := c.ID
			if len(short) > 7 {
				short = short[:7]
			}
			lines = append(lines, fmt.Sprintf("`%s` %s", short, integrations.Truncate(title, 100)))
		}
		branch := strings.TrimPrefix(e.Ref, "refs/heads/")
		return integrations.Card(fmt.Sprintf("%s pushed to %s", who, branch), e.Compare,
			strings.Join(lines, "\n"), "neutral", footer, nil), true, nil
	case "pull_request":
		pr := e.PullRequest
		if pr == nil {
			return api.Attachment{}, false, nil
		}
		color, verb := api.AttachmentColor("info"), e.Action
		switch e.Action {
		case "opened", "reopened", "ready_for_review":
		case "closed":
			color, verb = "neutral", "closed"
			if pr.Merged {
				color, verb = "success", "merged"
			}
		default:
			return api.Attachment{}, false, nil
		}
		return integrations.Card(fmt.Sprintf("#%d %s", pr.Number, pr.Title), pr.HTMLURL,
			fmt.Sprintf("%s %s the pull request.", who, strings.ReplaceAll(verb, "_", " ")), color, footer,
			[]integrations.Field{integrations.ShortField("Branches", pr.Head.Ref+" → "+pr.Base.Ref)}), true, nil
	case "pull_request_review":
		if e.PullRequest == nil || e.Review == nil || e.Action != "submitted" {
			return api.Attachment{}, false, nil
		}
		color, verb := api.AttachmentColor("neutral"), "reviewed"
		switch e.Review.State {
		case "approved":
			color, verb = "success", "approved"
		case "changes_requested":
			color, verb = "warning", "asked for changes to"
		}
		text := fmt.Sprintf("%s %s the pull request.", who, verb)
		if strings.TrimSpace(e.Review.Body) != "" {
			text += "\n\n" + quote(e.Review.Body)
		}
		return integrations.Card(fmt.Sprintf("#%d %s", e.PullRequest.Number, e.PullRequest.Title), e.Review.HTMLURL,
			text, color, footer, nil), true, nil
	case "issues":
		if e.Issue == nil {
			return api.Attachment{}, false, nil
		}
		color := api.AttachmentColor("info")
		switch e.Action {
		case "opened", "reopened":
		case "closed":
			color = "neutral"
		default:
			return api.Attachment{}, false, nil
		}
		return integrations.Card(fmt.Sprintf("#%d %s", e.Issue.Number, e.Issue.Title), e.Issue.HTMLURL,
			fmt.Sprintf("%s %s the issue.", who, e.Action), color, footer, nil), true, nil
	case "issue_comment":
		if e.Issue == nil || e.Comment == nil || e.Action != "created" {
			return api.Attachment{}, false, nil
		}
		return integrations.Card(fmt.Sprintf("#%d %s", e.Issue.Number, e.Issue.Title), e.Comment.HTMLURL,
			who+" commented.\n\n"+quote(e.Comment.Body), "neutral", footer, nil), true, nil
	case "workflow_run":
		run := e.WorkflowRun
		if run == nil || e.Action != "completed" {
			return api.Attachment{}, false, nil
		}
		color := api.AttachmentColor("neutral")
		switch run.Conclusion {
		case "success":
			color = "success"
		case "failure", "timed_out":
			color = "danger"
		}
		return integrations.Card(fmt.Sprintf("%s #%d %s", run.Name, run.RunNumber, run.Conclusion), run.HTMLURL, "",
			color, footer, []integrations.Field{
				integrations.ShortField("Branch", run.HeadBranch), integrations.ShortField("Result", run.Conclusion),
			}), true, nil
	case "release":
		if e.Release == nil || e.Action != "published" {
			return api.Attachment{}, false, nil
		}
		name := e.Release.Name
		if name == "" {
			name = e.Release.TagName
		}
		return integrations.Card("Released "+name, e.Release.HTMLURL, who+" published "+e.Release.TagName+".",
			"success", footer, nil), true, nil
	}
	return api.Attachment{}, false, nil
}

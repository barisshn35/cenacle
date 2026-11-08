// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	guuid "github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/audit"
	"github.com/Cenacle-TR/cenacle/server/internal/auth"
	"github.com/Cenacle-TR/cenacle/server/internal/egress"
	"github.com/Cenacle-TR/cenacle/server/internal/events"
	"github.com/Cenacle-TR/cenacle/server/internal/httpx"
	"github.com/Cenacle-TR/cenacle/server/internal/integrations/signing"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

// Limits and codes of workflows.
const (
	MaxWorkflows        = 100
	maxRunsPerHour      = 120
	maxWebhookVars      = 50
	workflowBatch       = 50
	CodeWorkflowLimit   = "workflow_limit"
	CodeTaskClosed      = "task_closed"
	CodeWorkflowBusy    = "workflow_busy"
	workflowHookPrefix  = "/api/workflow-hooks/"
	workflowTokenPrefix = "cnw_"
)

// Trigger kinds.
const (
	TriggerManual       = "manual"
	TriggerMemberJoined = "member_joined"
	TriggerReaction     = "reaction"
	TriggerKeyword      = "keyword"
	TriggerSchedule     = "schedule"
	TriggerWebhook      = "webhook"
)

// triggerHasPerson: the trigger names who started the run (forms and
// direct messages to them are possible).
func triggerHasPerson(kind string) bool {
	return kind == TriggerManual || kind == TriggerMemberJoined || kind == TriggerReaction || kind == TriggerKeyword
}

var stepIDRE = regexp.MustCompile(`^[a-z0-9_]{1,32}$`)

// cleanTrigger checks a trigger and returns its kind and the channel it watches.
func (h *Handlers) cleanTrigger(ctx context.Context, workspace pgtype.UUID, in api.WorkflowTrigger) (api.WorkflowTrigger, pgtype.UUID, string) {
	var channel pgtype.UUID
	if in.ChannelId != nil {
		c, err := h.Queries.GetChannel(ctx, pgUUID(*in.ChannelId))
		if err != nil || c.WorkspaceID != workspace || isConversation(c) || c.ArchivedAt.Valid {
			return in, channel, "The trigger's channel is not a channel of this workspace."
		}
		channel = c.ID
	}
	out := api.WorkflowTrigger{Kind: in.Kind, ChannelId: in.ChannelId}
	switch in.Kind {
	case TriggerManual, TriggerWebhook:
	case TriggerMemberJoined:
		if !channel.Valid {
			return in, channel, "Choose the channel people join."
		}
	case TriggerReaction:
		if !channel.Valid || in.Emoji == nil || (customEmojiName(*in.Emoji) == "" && !validEmoji(*in.Emoji)) {
			return in, channel, "Choose the channel and the emoji."
		}
		out.Emoji = in.Emoji
	case TriggerKeyword:
		if !channel.Valid || in.Keyword == nil {
			return in, channel, "Choose the channel and the keyword."
		}
		k := strings.TrimSpace(*in.Keyword)
		if k == "" || utf8.RuneCountInString(k) > 100 {
			return in, channel, "A keyword has 1 to 100 characters."
		}
		out.Keyword = &k
	case TriggerSchedule:
		if in.Schedule == nil {
			return in, channel, "Choose when the workflow runs."
		}
		s := *in.Schedule
		if _, err := time.LoadLocation(s.TimeZone); err != nil || s.TimeZone == "" {
			return in, channel, "Unknown time zone."
		}
		if _, err := time.Parse("15:04", s.Time); err != nil {
			return in, channel, "A time is HH:MM."
		}
		switch s.Every {
		case api.Day, api.Weekday:
			s.Weekday = nil
		case api.Week:
			if s.Weekday == nil || *s.Weekday < 0 || *s.Weekday > 6 {
				return in, channel, "Choose the day of the week."
			}
		default:
			return in, channel, "A schedule runs every day, every weekday or every week."
		}
		out.Schedule = &s
	default:
		return in, channel, "Unknown trigger."
	}
	return out, channel, ""
}

// cleanSteps checks the steps of a workflow with the trigger they follow.
func (h *Handlers) cleanSteps(ctx context.Context, workspace pgtype.UUID, trigger api.WorkflowTrigger, in []api.WorkflowStep) ([]api.WorkflowStep, string) {
	if len(in) == 0 || len(in) > 25 {
		return nil, "A workflow has 1 to 25 steps."
	}
	person := triggerHasPerson(string(trigger.Kind))
	hasChannel := trigger.ChannelId != nil || trigger.Kind == TriggerManual
	seen := map[string]bool{}
	text := func(s api.WorkflowStep) (string, bool) {
		if s.Text == nil {
			return "", false
		}
		t := strings.TrimSpace(*s.Text)
		return t, t != "" && utf8.RuneCountInString(t) <= 4000
	}
	member := func(id openapi_types.UUID) bool {
		_, err := h.Queries.GetWorkspaceMemberName(ctx, store.GetWorkspaceMemberNameParams{WorkspaceID: workspace, UserID: pgUUID(id)})
		return err == nil
	}
	out := make([]api.WorkflowStep, len(in))
	for i, s := range in {
		if !stepIDRE.MatchString(s.Id) || seen[s.Id] {
			return nil, "Each step has a different id of 1 to 32 lowercase letters, digits or _."
		}
		seen[s.Id] = true
		clean := api.WorkflowStep{Id: s.Id, Kind: s.Kind}
		n := strconv.Itoa(i + 1)
		switch s.Kind {
		case api.WorkflowStepKindMessage:
			t, ok := text(s)
			if !ok {
				return nil, "Step " + n + ": a message has 1 to 4000 characters."
			}
			clean.Text = &t
			if s.ChannelId != nil {
				c, err := h.Queries.GetChannel(ctx, pgUUID(*s.ChannelId))
				if err != nil || c.WorkspaceID != workspace || isConversation(c) {
					return nil, "Step " + n + ": the channel is not a channel of this workspace."
				}
				if c.Encrypted {
					return nil, "Step " + n + ": a workflow cannot write in an encrypted channel."
				}
				clean.ChannelId = s.ChannelId
			} else if !hasChannel {
				return nil, "Step " + n + ": choose the channel to post in."
			}
		case api.WorkflowStepKindDm:
			t, ok := text(s)
			if !ok {
				return nil, "Step " + n + ": a message has 1 to 4000 characters."
			}
			clean.Text = &t
			if s.To != nil && *s.To != "" {
				id, err := guuid.Parse(*s.To)
				if err != nil || !member(id) {
					return nil, "Step " + n + ": the recipient is not a member of this workspace."
				}
				to := id.String()
				clean.To = &to
			} else if !person {
				return nil, "Step " + n + ": choose who receives the message (this trigger has no person)."
			}
		case api.WorkflowStepKindForm:
			if !person {
				return nil, "Step " + n + ": forms need a person who starts the workflow."
			}
			if s.FormId == nil {
				return nil, "Step " + n + ": choose the form."
			}
			f, err := h.Queries.GetForm(ctx, pgUUID(*s.FormId))
			if err != nil || f.WorkspaceID != workspace || f.ArchivedAt.Valid {
				return nil, "Step " + n + ": the form is not a form of this workspace."
			}
			clean.FormId = s.FormId
		case api.WorkflowStepKindApproval:
			t, ok := text(s)
			if !ok {
				return nil, "Step " + n + ": the request has 1 to 4000 characters."
			}
			clean.Text = &t
			if s.Approvers == nil || len(*s.Approvers) == 0 || len(*s.Approvers) > 20 {
				return nil, "Step " + n + ": choose 1 to 20 approvers."
			}
			approvers := []openapi_types.UUID{}
			for _, a := range *s.Approvers {
				if !member(a) {
					return nil, "Step " + n + ": an approver is not a member of this workspace."
				}
				if !slices.Contains(approvers, a) {
					approvers = append(approvers, a)
				}
			}
			clean.Approvers = &approvers
		case api.WorkflowStepKindDelay:
			if s.Minutes == nil || *s.Minutes < 1 || *s.Minutes > 10080 {
				return nil, "Step " + n + ": wait 1 minute to 7 days."
			}
			clean.Minutes = s.Minutes
		case api.WorkflowStepKindHttp:
			if s.Url == nil {
				return nil, "Step " + n + ": enter the address."
			}
			u := strings.TrimSpace(*s.Url)
			if h.Egress == nil {
				return nil, "Step " + n + ": outgoing requests are not available on this server."
			}
			if _, err := h.Egress.CheckURL(u); err != nil {
				return nil, "Step " + n + ": " + err.Error() + "."
			}
			clean.Url = &u
		default:
			return nil, "Step " + n + ": unknown kind."
		}
		out[i] = clean
	}
	return out, ""
}

// nextRun returns the first time after `after` a schedule runs.
func nextRun(s api.WorkflowSchedule, after time.Time) time.Time {
	loc, err := time.LoadLocation(s.TimeZone)
	if err != nil {
		loc = time.UTC
	}
	at, _ := time.Parse("15:04", s.Time)
	local := after.In(loc)
	for d := 0; d < 8; d++ {
		day := local.AddDate(0, 0, d)
		t := time.Date(day.Year(), day.Month(), day.Day(), at.Hour(), at.Minute(), 0, 0, loc)
		if !t.After(after) {
			continue
		}
		wd := int(t.Weekday())
		switch s.Every {
		case api.Weekday:
			if wd == 0 || wd == 6 {
				continue
			}
		case api.Week:
			if s.Weekday == nil || wd != *s.Weekday {
				continue
			}
		}
		return t
	}
	return after.Add(24 * time.Hour)
}

func workflowAPI(wf store.Workflow) api.Workflow {
	out := api.Workflow{Id: uuid(wf.ID), Name: wf.Name, Description: wf.Description, Enabled: wf.Enabled,
		UpdatedAt: wf.UpdatedAt, NextRunAt: timePtr(wf.NextRunAt), Steps: []api.WorkflowStep{}}
	_ = json.Unmarshal(wf.Trigger, &out.Trigger)
	_ = json.Unmarshal(wf.Steps, &out.Steps)
	return out
}

func newWorkflowToken() (token string, hash []byte) {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	token = workflowTokenPrefix + base64.RawURLEncoding.EncodeToString(b)
	sum := sha256.Sum256([]byte(token))
	return token, sum[:]
}

func (h *Handlers) workflowURL(token string) string {
	return strings.TrimSuffix(h.PublicURL, "/") + workflowHookPrefix + token
}

// ListWorkflows implements api.ServerInterface.
func (h *Handlers) ListWorkflows(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !h.requireWorkspaceAdmin(w, r, workspaceID, p.User, "Only the workspace's owners and admins manage workflows.") {
		return
	}
	rows, err := h.Queries.ListWorkflows(r.Context(), pgUUID(workspaceID))
	if err != nil {
		h.unavailable(w, r, "list workflows", err)
		return
	}
	out := make([]api.Workflow, len(rows))
	for i, wf := range rows {
		out[i] = workflowAPI(wf)
	}
	httpx.WriteJSON(w, http.StatusOK, map[string][]api.Workflow{"workflows": out})
}

// workflowInput checks a workflow as sent.
func (h *Handlers) workflowInput(ctx context.Context, workspace pgtype.UUID, in api.WorkflowInput) (store.CreateWorkflowParams, string) {
	var out store.CreateWorkflowParams
	out.Name = strings.TrimSpace(in.Name)
	if out.Name == "" || utf8.RuneCountInString(out.Name) > 120 {
		return out, "A workflow's name has 1 to 120 characters."
	}
	if in.Description != nil {
		out.Description = strings.TrimSpace(*in.Description)
	}
	if utf8.RuneCountInString(out.Description) > 1000 {
		return out, "A workflow's description is longer than 1000 characters."
	}
	out.Enabled = in.Enabled == nil || *in.Enabled
	trigger, channel, problem := h.cleanTrigger(ctx, workspace, in.Trigger)
	if problem != "" {
		return out, problem
	}
	steps, problem := h.cleanSteps(ctx, workspace, trigger, in.Steps)
	if problem != "" {
		return out, problem
	}
	out.Trigger, _ = json.Marshal(trigger)
	out.Steps, _ = json.Marshal(steps)
	out.TriggerKind = string(trigger.Kind)
	out.ChannelID = channel
	if trigger.Schedule != nil {
		out.NextRunAt = pgtype.Timestamptz{Time: nextRun(*trigger.Schedule, time.Now()), Valid: true}
	}
	return out, ""
}

// CreateWorkflow implements api.ServerInterface.
func (h *Handlers) CreateWorkflow(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.WorkflowInput
	if !decode(w, r, &in) || !h.requireWorkspaceAdmin(w, r, workspaceID, p.User, "Only the workspace's owners and admins write workflows.") {
		return
	}
	arg, problem := h.workflowInput(r.Context(), pgUUID(workspaceID), in)
	if problem != "" {
		badRequest(w, r, problem)
		return
	}
	n, err := h.Queries.CountWorkflows(r.Context(), pgUUID(workspaceID))
	if err != nil {
		h.unavailable(w, r, "count workflows", err)
		return
	}
	if n >= MaxWorkflows {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeWorkflowLimit, Detail: "A workspace has up to 100 workflows."})
		return
	}
	var token string
	if arg.TriggerKind == TriggerWebhook {
		token, arg.WebhookHash = newWorkflowToken()
	}
	arg.WorkspaceID, arg.CreatedBy, arg.Secret = pgUUID(workspaceID), p.User.ID, signing.NewSecret()
	wf, err := h.Queries.CreateWorkflow(r.Context(), arg)
	if err != nil {
		h.unavailable(w, r, "create workflow", err)
		return
	}
	h.record(r, wf.WorkspaceID, audit.WorkflowChanged, "workflow", uuid(wf.ID).String(), map[string]any{"name": wf.Name, "change": "created"})
	out := workflowAPI(wf)
	out.Secret = &wf.Secret
	if token != "" {
		out.WebhookUrl = ptr(h.workflowURL(token))
	}
	httpx.WriteJSON(w, http.StatusCreated, out)
}

// adminWorkflow loads a workflow of a workspace the user administers.
func (h *Handlers) adminWorkflow(w http.ResponseWriter, r *http.Request, id openapi_types.UUID, user store.User) (store.Workflow, bool) {
	wf, err := h.Queries.GetWorkflow(r.Context(), pgUUID(id))
	if isNoRows(err) || (err == nil && wf.ArchivedAt.Valid) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No such workflow."})
		return wf, false
	}
	if err != nil {
		h.unavailable(w, r, "get workflow", err)
		return wf, false
	}
	return wf, h.requireWorkspaceAdmin(w, r, uuid(wf.WorkspaceID), user, "Only the workspace's owners and admins change workflows.")
}

// UpdateWorkflow implements api.ServerInterface.
func (h *Handlers) UpdateWorkflow(w http.ResponseWriter, r *http.Request, workflowID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.WorkflowInput
	if !decode(w, r, &in) {
		return
	}
	wf, ok := h.adminWorkflow(w, r, workflowID, p.User)
	if !ok {
		return
	}
	arg, problem := h.workflowInput(r.Context(), wf.WorkspaceID, in)
	if problem != "" {
		badRequest(w, r, problem)
		return
	}
	var token string
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		var err error
		wf, err = q.UpdateWorkflow(r.Context(), store.UpdateWorkflowParams{
			ID: wf.ID, Name: arg.Name, Description: arg.Description, Enabled: arg.Enabled, Trigger: arg.Trigger,
			TriggerKind: arg.TriggerKind, ChannelID: arg.ChannelID, Steps: arg.Steps, NextRunAt: arg.NextRunAt,
		})
		if err != nil {
			return err
		}
		// A webhook address exists only while the trigger is a webhook.
		switch {
		case arg.TriggerKind == TriggerWebhook && wf.WebhookHash == nil:
			var hash []byte
			token, hash = newWorkflowToken()
			return q.SetWorkflowWebhook(r.Context(), store.SetWorkflowWebhookParams{ID: wf.ID, WebhookHash: hash})
		case arg.TriggerKind != TriggerWebhook && wf.WebhookHash != nil:
			return q.SetWorkflowWebhook(r.Context(), store.SetWorkflowWebhookParams{ID: wf.ID})
		}
		return nil
	})
	if err != nil {
		h.unavailable(w, r, "update workflow", err)
		return
	}
	h.record(r, wf.WorkspaceID, audit.WorkflowChanged, "workflow", uuid(wf.ID).String(), map[string]any{"name": wf.Name, "change": "updated"})
	out := workflowAPI(wf)
	if token != "" {
		out.WebhookUrl = ptr(h.workflowURL(token))
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// ArchiveWorkflow implements api.ServerInterface.
func (h *Handlers) ArchiveWorkflow(w http.ResponseWriter, r *http.Request, workflowID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	wf, ok := h.adminWorkflow(w, r, workflowID, p.User)
	if !ok {
		return
	}
	if err := h.Queries.ArchiveWorkflow(r.Context(), wf.ID); err != nil {
		h.unavailable(w, r, "archive workflow", err)
		return
	}
	h.record(r, wf.WorkspaceID, audit.WorkflowChanged, "workflow", uuid(wf.ID).String(), map[string]any{"name": wf.Name, "change": "archived"})
	w.WriteHeader(http.StatusNoContent)
}

// RotateWorkflowWebhook implements api.ServerInterface.
func (h *Handlers) RotateWorkflowWebhook(w http.ResponseWriter, r *http.Request, workflowID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	wf, ok := h.adminWorkflow(w, r, workflowID, p.User)
	if !ok {
		return
	}
	if wf.TriggerKind != TriggerWebhook {
		badRequest(w, r, "Only webhook workflows have an address.")
		return
	}
	token, hash := newWorkflowToken()
	if err := h.Queries.SetWorkflowWebhook(r.Context(), store.SetWorkflowWebhookParams{ID: wf.ID, WebhookHash: hash}); err != nil {
		h.unavailable(w, r, "rotate webhook", err)
		return
	}
	h.record(r, wf.WorkspaceID, audit.WorkflowChanged, "workflow", uuid(wf.ID).String(), map[string]any{"name": wf.Name, "change": "webhook_rotated"})
	out := workflowAPI(wf)
	out.WebhookUrl = ptr(h.workflowURL(token))
	httpx.WriteJSON(w, http.StatusOK, out)
}

func runAPIOf(run store.WorkflowRun, triggerName string) api.WorkflowRun {
	var steps []json.RawMessage
	_ = json.Unmarshal(run.Steps, &steps)
	out := api.WorkflowRun{Id: uuid(run.ID), WorkflowName: run.WorkflowName, Status: api.WorkflowRunStatus(run.Status),
		Step: int(run.Step), Steps: len(steps), Error: run.Error, CreatedAt: run.CreatedAt, FinishedAt: timePtr(run.FinishedAt)}
	if run.WorkflowID.Valid {
		out.WorkflowId = ptr(uuid(run.WorkflowID))
	}
	if run.ChannelID.Valid {
		out.ChannelId = ptr(uuid(run.ChannelID))
	}
	if run.TriggerUserID.Valid {
		out.TriggerUser = &api.Author{Id: uuid(run.TriggerUserID), DisplayName: triggerName}
	}
	return out
}

// ListWorkflowRuns implements api.ServerInterface.
func (h *Handlers) ListWorkflowRuns(w http.ResponseWriter, r *http.Request, workflowID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	wf, ok := h.adminWorkflow(w, r, workflowID, p.User)
	if !ok {
		return
	}
	rows, err := h.Queries.ListWorkflowRuns(r.Context(), store.ListWorkflowRunsParams{WorkflowID: wf.ID, RowLimit: 50})
	if err != nil {
		h.unavailable(w, r, "list runs", err)
		return
	}
	out := make([]api.WorkflowRun, len(rows))
	for i, run := range rows {
		out[i] = runAPIOf(store.WorkflowRun{ID: run.ID, WorkflowID: run.WorkflowID, WorkspaceID: run.WorkspaceID,
			WorkflowName: run.WorkflowName, Steps: run.Steps, Step: run.Step, Status: run.Status, Vars: run.Vars,
			WakeAt: run.WakeAt, TriggerUserID: run.TriggerUserID, ChannelID: run.ChannelID, Error: run.Error,
			CreatedAt: run.CreatedAt, FinishedAt: run.FinishedAt}, run.TriggerUserName)
	}
	httpx.WriteJSON(w, http.StatusOK, map[string][]api.WorkflowRun{"runs": out})
}

// ListShortcuts implements api.ServerInterface.
func (h *Handlers) ListShortcuts(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	c, role, ok := h.memberChannel(w, r, channelID, p.User)
	if !ok {
		return
	}
	shortcuts := []api.WorkflowShortcut{}
	forms := []api.Form{}
	if canPost(c, role) {
		wfs, err := h.Queries.ListManualWorkflows(r.Context(), store.ListManualWorkflowsParams{WorkspaceID: c.WorkspaceID, ChannelID: c.ID})
		if err != nil {
			h.unavailable(w, r, "list shortcuts", err)
			return
		}
		for _, wf := range wfs {
			shortcuts = append(shortcuts, api.WorkflowShortcut{Id: uuid(wf.ID), Name: wf.Name, Description: wf.Description})
		}
	}
	if canPost(c, role) && !c.Encrypted { // answers cannot go to encrypted channels
		fs, err := h.Queries.ListForms(r.Context(), c.WorkspaceID)
		if err != nil {
			h.unavailable(w, r, "list forms", err)
			return
		}
		for _, f := range fs {
			forms = append(forms, formAPI(f))
		}
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"workflows": shortcuts, "forms": forms})
}

// runVars are a run's variables ({{trigger.user}}, {{form.x}}, …).
type runVars map[string]string

var varRE = regexp.MustCompile(`\{\{\s*([a-z0-9_]+(?:\.[a-z0-9_]+)*)\s*\}\}`)

// render fills a step's text with the run's variables; unknown ones are empty.
func (v runVars) render(text string) string {
	return varRE.ReplaceAllStringFunc(text, func(m string) string {
		return v[varRE.FindStringSubmatch(m)[1]]
	})
}

// newRun starts a run of a workflow (inside the caller's transaction);
// message is the message that triggered it, whose text is in vars.
func newRun(ctx context.Context, q *store.Queries, wf store.Workflow, user pgtype.UUID, channel pgtype.UUID, message pgtype.UUID, vars runVars) (store.WorkflowRun, error) {
	vars["workflow.name"] = wf.Name
	if user.Valid {
		vars["trigger.user"] = "<@" + uuid(user).String() + ">"
		if u, err := q.GetUser(ctx, user); err == nil {
			vars["trigger.user_name"] = u.DisplayName
		}
	}
	if channel.Valid {
		if c, err := q.GetChannel(ctx, channel); err == nil {
			vars["trigger.channel"] = c.Name
		}
	}
	raw, _ := json.Marshal(vars)
	return q.CreateWorkflowRun(ctx, store.CreateWorkflowRunParams{
		WorkflowID: wf.ID, WorkspaceID: wf.WorkspaceID, WorkflowName: wf.Name, Steps: wf.Steps, Vars: raw,
		TriggerUserID: user, ChannelID: channel, TriggerMessageID: message,
	})
}

// busy: the workflow started too many runs in the last hour.
func busy(ctx context.Context, q *store.Queries, wf store.Workflow) (bool, error) {
	n, err := q.CountRecentWorkflowRuns(ctx, wf.ID)
	return n >= maxRunsPerHour, err
}

// StartWorkflow implements api.ServerInterface.
func (h *Handlers) StartWorkflow(w http.ResponseWriter, r *http.Request, workflowID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.StartWorkflowJSONBody
	if !decode(w, r, &in) {
		return
	}
	wf, err := h.Queries.GetWorkflow(r.Context(), pgUUID(workflowID))
	if isNoRows(err) || (err == nil && (wf.ArchivedAt.Valid || !wf.Enabled || wf.TriggerKind != TriggerManual)) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No such workflow."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "get workflow", err)
		return
	}
	c, role, ok := h.memberChannel(w, r, in.ChannelId, p.User)
	if !ok {
		return
	}
	if c.WorkspaceID != wf.WorkspaceID || !canPost(c, role) || (wf.ChannelID.Valid && wf.ChannelID != c.ID) {
		forbidden(w, r, httpx.CodeForbidden, "This workflow does not run in this channel.")
		return
	}
	if h.timedOut(w, r, c.WorkspaceID, p.User) {
		return
	}
	var run store.WorkflowRun
	var task *api.Task
	err = h.inTx(r.Context(), func(q *store.Queries) error {
		if b, err := busy(r.Context(), q, wf); err != nil || b {
			if b {
				err = errWorkflowBusy
			}
			return err
		}
		var err error
		run, err = newRun(r.Context(), q, wf, p.User.ID, c.ID, pgtype.UUID{}, runVars{})
		if err != nil {
			return err
		}
		// Steps that need no outside request run at once, so a form shows now.
		run, err = advance(r.Context(), q, nil, run, true)
		if err != nil {
			return err
		}
		if run.Status == "waiting" {
			tasks, err := q.ListOpenWorkflowTasks(r.Context(), store.ListOpenWorkflowTasksParams{WorkspaceID: wf.WorkspaceID, UserID: p.User.ID})
			if err != nil {
				return err
			}
			for _, t := range tasks {
				if t.RunID == run.ID && t.Kind == "form" {
					full, err := taskWithForm(r.Context(), q, store.WorkflowTask{ID: t.ID, RunID: t.RunID, WorkspaceID: t.WorkspaceID,
						Kind: t.Kind, Title: t.Title, Assignees: t.Assignees, FormID: t.FormID, Status: t.Status, CreatedAt: t.CreatedAt}, "")
					if err != nil {
						return err
					}
					task = &full
				}
			}
		}
		return nil
	})
	if errors.Is(err, errWorkflowBusy) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusTooManyRequests, Code: CodeWorkflowBusy,
			Detail: "This workflow ran too often in the last hour."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "start workflow", err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, map[string]any{"run": runAPIOf(run, p.User.DisplayName), "task": task})
}

var errWorkflowBusy = errors.New("workflow busy")

// TriggerWorkflowWebhook implements api.ServerInterface.
func (h *Handlers) TriggerWorkflowWebhook(w http.ResponseWriter, r *http.Request, token string) {
	sum := sha256.Sum256([]byte(token))
	wf, err := h.Queries.GetWorkflowByWebhook(r.Context(), sum[:])
	if isNoRows(err) || (err == nil && !wf.Enabled) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "Unknown address."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "get workflow", err)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
	var fields map[string]any
	if err != nil || json.Unmarshal(body, &fields) != nil {
		badRequest(w, r, "The body is a JSON object of up to 64 KiB.")
		return
	}
	vars := runVars{}
	for k, v := range fields {
		if len(vars) >= maxWebhookVars || !fieldIDRE.MatchString(k) {
			continue
		}
		switch val := v.(type) {
		case string:
			vars["webhook."+k] = truncate(val, 1000)
		case float64:
			vars["webhook."+k] = strconv.FormatFloat(val, 'f', -1, 64)
		case bool:
			vars["webhook."+k] = strconv.FormatBool(val)
		}
	}
	err = h.inTx(r.Context(), func(q *store.Queries) error {
		if b, err := busy(r.Context(), q, wf); err != nil || b {
			if b {
				err = errWorkflowBusy
			}
			return err
		}
		_, err := newRun(r.Context(), q, wf, pgtype.UUID{}, wf.ChannelID, pgtype.UUID{}, vars)
		return err
	})
	if errors.Is(err, errWorkflowBusy) {
		w.Header().Set("Retry-After", "60")
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusTooManyRequests, Code: CodeWorkflowBusy,
			Detail: "This workflow ran too often in the last hour."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "start workflow", err)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

// triggerWorkflows starts the workflows a channel event triggers (inside the
// caller's transaction); message is the message the event is about, if any.
// Workflows never trigger on bots, their own messages included, so they
// cannot start each other in a loop.
func triggerWorkflows(ctx context.Context, q *store.Queries, kind string, c store.Channel, user store.User, message pgtype.UUID, match func(api.WorkflowTrigger) bool, vars runVars) error {
	if user.IsBot || isConversation(c) {
		return nil
	}
	wfs, err := q.ListTriggeredWorkflows(ctx, store.ListTriggeredWorkflowsParams{TriggerKind: kind, ChannelID: c.ID})
	if err != nil {
		return err
	}
	for _, wf := range wfs {
		var t api.WorkflowTrigger
		_ = json.Unmarshal(wf.Trigger, &t)
		if match != nil && !match(t) {
			continue
		}
		if b, err := busy(ctx, q, wf); err != nil || b {
			if err != nil {
				return err
			}
			continue
		}
		v := runVars{}
		for k, val := range vars {
			v[k] = val
		}
		if _, err := newRun(ctx, q, wf, user.ID, c.ID, message, v); err != nil {
			return err
		}
	}
	return nil
}

// memberJoined starts the workflows that greet people joining a channel.
func (h *Handlers) memberJoined(ctx context.Context, c store.Channel, user store.User) {
	err := h.inTx(ctx, func(q *store.Queries) error {
		return triggerWorkflows(ctx, q, TriggerMemberJoined, c, user, pgtype.UUID{}, nil, runVars{})
	})
	if err != nil {
		h.Log.ErrorContext(ctx, "start workflows", "error", err)
	}
}

// ----------------------------------------------------------------- engine ---

// WorkflowRunner runs workflows' steps and starts scheduled workflows (a
// periodic job).
type WorkflowRunner struct {
	DB      TxBeginner
	Queries *store.Queries
	Egress  *egress.Client
	Log     *slog.Logger
}

// Run implements jobs.Runner.
func (wr *WorkflowRunner) Run(ctx context.Context) (int, error) {
	n := 0
	err := inTx(ctx, wr.DB, func(q *store.Queries) error {
		due, err := q.ClaimDueSchedules(ctx, workflowBatch)
		if err != nil {
			return err
		}
		for _, wf := range due {
			var t api.WorkflowTrigger
			_ = json.Unmarshal(wf.Trigger, &t)
			next := time.Now().Add(24 * time.Hour)
			if t.Schedule != nil {
				next = nextRun(*t.Schedule, time.Now())
			}
			if err := q.SetWorkflowNextRun(ctx, store.SetWorkflowNextRunParams{ID: wf.ID, NextRunAt: pgtype.Timestamptz{Time: next, Valid: true}}); err != nil {
				return err
			}
			if _, err := newRun(ctx, q, wf, pgtype.UUID{}, wf.ChannelID, pgtype.UUID{}, runVars{}); err != nil {
				return err
			}
			n++
		}
		return nil
	})
	if err != nil {
		return n, err
	}
	// One run per transaction: a failing run does not hold back the others.
	for range workflowBatch {
		found := false
		err := inTx(ctx, wr.DB, func(q *store.Queries) error {
			runs, err := q.ClaimDueWorkflowRuns(ctx, 1)
			if err != nil || len(runs) == 0 {
				return err
			}
			found = true
			_, err = advance(ctx, q, wr.Egress, runs[0], false)
			return err
		})
		if err != nil {
			return n, err
		}
		if !found {
			break
		}
		n++
	}
	return n, nil
}

// advance runs a run's steps until it waits, sleeps, ends or fails, and saves
// it. With quick, it stops before steps that call other servers (they run in
// the background).
func advance(ctx context.Context, q *store.Queries, out *egress.Client, run store.WorkflowRun, quick bool) (store.WorkflowRun, error) {
	var steps []api.WorkflowStep
	_ = json.Unmarshal(run.Steps, &steps)
	vars := runVars{}
	_ = json.Unmarshal(run.Vars, &vars)
	vars["run.id"] = uuid(run.ID).String()
	// A deleted or removed message's text is not published again.
	if run.TriggerMessageID.Valid {
		live, err := q.MessageLive(ctx, run.TriggerMessageID)
		if err != nil {
			return run, err
		}
		if !live {
			delete(vars, "trigger.message")
		}
	}
	status, wake, problem := "running", time.Now(), ""
	bot, err := systemBot(ctx, q, run.WorkspaceID)
	if err != nil {
		return run, err
	}
loop:
	for int(run.Step) < len(steps) {
		s := steps[run.Step]
		switch s.Kind {
		case api.WorkflowStepKindMessage:
			channel := run.ChannelID
			if s.ChannelId != nil {
				channel = pgUUID(*s.ChannelId)
			}
			c, err := q.GetChannel(ctx, channel)
			if isNoRows(err) || (err == nil && c.ArchivedAt.Valid) {
				status, problem = "failed", "The channel is gone or archived."
				break loop
			}
			// Encrypted since the workflow was made: a bot cannot write in it.
			if err == nil && c.Encrypted {
				status, problem = "failed", "The channel is encrypted end to end."
				break loop
			}
			if err != nil {
				return run, err
			}
			text := vars.render(deref1(s.Text))
			v, refused, err := workflowRules(ctx, q, c, bot, deref1(s.Text), text)
			if err != nil {
				return run, err
			}
			if refused != "" {
				status, problem = "failed", refused
				break loop
			}
			if _, err := postWorkflowMessage(ctx, q, c, bot, text, run, s, pgtype.UUID{}, v); errors.Is(err, errEncrypted) {
				status, problem = "failed", "The conversation is encrypted end to end."
				break loop
			} else if err != nil {
				return run, err
			}
		case api.WorkflowStepKindDm:
			to := run.TriggerUserID
			if s.To != nil && *s.To != "" {
				if id, err := guuid.Parse(*s.To); err == nil {
					to = pgUUID(id)
				}
			}
			if !to.Valid {
				status, problem = "failed", "Nobody to send the message to."
				break loop
			}
			dm, err := botConversation(ctx, q, run.WorkspaceID, bot, to)
			if errors.Is(err, errNotInWorkspace) {
				status, problem = "failed", "The person is no longer in the workspace."
				break loop
			}
			if err != nil {
				return run, err
			}
			text := vars.render(deref1(s.Text))
			v, refused, err := workflowRules(ctx, q, dm, bot, deref1(s.Text), text)
			if err != nil {
				return run, err
			}
			if refused != "" {
				status, problem = "failed", refused
				break loop
			}
			if _, err := postWorkflowMessage(ctx, q, dm, bot, text, run, s, pgtype.UUID{}, v); errors.Is(err, errEncrypted) {
				status, problem = "failed", "The conversation is encrypted end to end."
				break loop
			} else if err != nil {
				return run, err
			}
		case api.WorkflowStepKindForm, api.WorkflowStepKindApproval:
			var assignees []pgtype.UUID
			title := ""
			var form pgtype.UUID
			if s.Kind == api.WorkflowStepKindForm {
				if !run.TriggerUserID.Valid || s.FormId == nil {
					status, problem = "failed", "Nobody to fill in the form."
					break loop
				}
				f, err := q.GetForm(ctx, pgUUID(*s.FormId))
				if isNoRows(err) || (err == nil && f.ArchivedAt.Valid) {
					status, problem = "failed", "The form is gone."
					break loop
				}
				if err != nil {
					return run, err
				}
				assignees, title, form = []pgtype.UUID{run.TriggerUserID}, f.Name, f.ID
			} else {
				// Approvers who left the workspace get nothing of it.
				for _, a := range deref(s.Approvers) {
					role, err := q.GetWorkspaceRole(ctx, store.GetWorkspaceRoleParams{WorkspaceID: run.WorkspaceID, UserID: pgUUID(a)})
					if err != nil {
						return run, err
					}
					if role != "" {
						assignees = append(assignees, pgUUID(a))
					}
				}
				if len(assignees) == 0 {
					status, problem = "failed", "None of the approvers is in the workspace any more."
					break loop
				}
				title = truncate(vars.render(deref1(s.Text)), 4000)
				if strings.TrimSpace(title) == "" {
					title = run.WorkflowName
				}
			}
			task, err := q.CreateWorkflowTask(ctx, store.CreateWorkflowTaskParams{
				RunID: run.ID, WorkspaceID: run.WorkspaceID, Kind: string(s.Kind), Title: title, Assignees: assignees, FormID: form,
			})
			if err != nil {
				return run, err
			}
			for _, person := range assignees {
				dm, err := botConversation(ctx, q, run.WorkspaceID, bot, person)
				if errors.Is(err, errNotInWorkspace) {
					status, problem = "failed", "The person is no longer in the workspace."
					break loop
				}
				if err != nil {
					return run, err
				}
				if _, err := postWorkflowMessage(ctx, q, dm, bot, "", run, s, task.ID, postVerdict{}); errors.Is(err, errEncrypted) {
					status, problem = "failed", "The conversation is encrypted end to end."
					break loop
				} else if err != nil {
					return run, err
				}
			}
			run.Step++
			status = "waiting"
			break loop
		case api.WorkflowStepKindDelay:
			run.Step++
			wake = time.Now().Add(time.Duration(deref0(s.Minutes)) * time.Minute)
			break loop
		case api.WorkflowStepKindHttp:
			if quick || out == nil {
				break loop
			}
			if p := callOut(ctx, out, run, vars, deref1(s.Url), q); p != "" {
				status, problem = "failed", p
				break loop
			}
		}
		run.Step++
	}
	if status == "running" && int(run.Step) >= len(steps) && wake.Before(time.Now().Add(time.Second)) {
		status = "done"
	}
	raw, _ := json.Marshal(vars)
	run.Status, run.Vars, run.Error = status, raw, problem
	run.WakeAt = wake
	if err := q.SaveWorkflowRun(ctx, store.SaveWorkflowRunParams{ID: run.ID, Step: run.Step, Status: status, Vars: raw, WakeAt: wake, Error: problem}); err != nil {
		return run, err
	}
	return run, nil
}

func deref1(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func deref0(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}

// workflowRules holds the text a run's variables put into a step's message
// (what a webhook's sender or a member wrote) to the posting rules of a
// member: it may not mention everyone, notify groups or pass AutoMod where
// they could not. What the workflow's admins wrote themselves stays allowed.
// It returns why the rules refuse the message.
func workflowRules(ctx context.Context, q *store.Queries, c store.Channel, bot store.User, template, text string) (postVerdict, string, error) {
	if text == template {
		return postVerdict{}, "", nil
	}
	v, no, err := postingRules(ctx, q, c, access{ch: RoleMember, ws: WorkspaceMember}, bot, text,
		postOptions{anyChannel: true, granted: broadcasts(template)})
	if err != nil || no == nil {
		return v, "", err
	}
	return v, no.detail, nil
}

// postWorkflowMessage posts a step's message as the workspace's system bot,
// with the workflow's name as a card title (people see what sent it).
func postWorkflowMessage(ctx context.Context, q *store.Queries, c store.Channel, bot store.User, body string, run store.WorkflowRun, s api.WorkflowStep, task pgtype.UUID, v postVerdict) (api.Message, error) {
	nonce := fmt.Sprintf("wf-%s-%s", uuid(run.ID), s.Id)
	if task.Valid {
		nonce += "-" + uuid(c.ID).String()[:8]
	}
	body = truncate(body, MaxBodyLength)
	attachments, _ := json.Marshal([]map[string]string{{"footer": "⚡ " + run.WorkflowName}})
	if task.Valid || body == "" {
		attachments = []byte("[]")
	}
	m, err := postMessageTo(ctx, q, c, bot, body, nonce, attachments, replyTo{}, postExtras{task: task, noGroups: v.noGroups})
	if err != nil {
		return m, err
	}
	return m, flagMessage(ctx, q, c, m.Id, v.flags)
}

// callOut sends a workflow's variables to another server, signed like event
// deliveries; it returns why it failed.
func callOut(ctx context.Context, out *egress.Client, run store.WorkflowRun, vars runVars, url string, q *store.Queries) string {
	wf, err := q.GetWorkflow(ctx, run.WorkflowID)
	if err != nil {
		return "The workflow is gone."
	}
	body, _ := json.Marshal(map[string]any{"workflow": run.WorkflowName, "run_id": uuid(run.ID).String(), "variables": vars})
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return "The address is not valid."
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Cenacle")
	req.Header.Set(signing.Header, signing.Sign(wf.Secret, time.Now(), body))
	res, err := out.Do(req)
	switch {
	case errors.Is(err, egress.ErrForbiddenAddress):
		return "The address is in a private network that is not allowed."
	case err != nil:
		return "The request failed: " + truncate(err.Error(), 200)
	case res.Status < 200 || res.Status > 299:
		return "The server answered " + strconv.Itoa(res.Status) + "."
	}
	return ""
}

// ------------------------------------------------------------------ tasks ---

func taskAPI(t store.WorkflowTask, doneBy string) api.Task {
	out := api.Task{Id: uuid(t.ID), Kind: api.TaskKind(t.Kind), Title: t.Title, Status: api.TaskStatus(t.Status),
		Comment: t.Comment, CreatedAt: t.CreatedAt, DoneAt: timePtr(t.DoneAt), Assignees: make([]openapi_types.UUID, len(t.Assignees))}
	for i, a := range t.Assignees {
		out.Assignees[i] = uuid(a)
	}
	if t.DoneBy.Valid {
		out.DoneBy = &api.Author{Id: uuid(t.DoneBy), DisplayName: doneBy}
	}
	return out
}

// taskWithForm is a task with its form's fields (for filling it in).
func taskWithForm(ctx context.Context, q store.Querier, t store.WorkflowTask, doneBy string) (api.Task, error) {
	out := taskAPI(t, doneBy)
	if t.FormID.Valid {
		f, err := q.GetForm(ctx, t.FormID)
		if err != nil && !isNoRows(err) {
			return out, err
		}
		if err == nil {
			fa := formAPI(f)
			out.Form = &fa
		}
	}
	return out, nil
}

// ListMyTasks implements api.ServerInterface.
func (h *Handlers) ListMyTasks(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	if _, ok := h.workspaceRole(w, r, workspaceID, p.User); !ok {
		return
	}
	rows, err := h.Queries.ListOpenWorkflowTasks(r.Context(), store.ListOpenWorkflowTasksParams{WorkspaceID: pgUUID(workspaceID), UserID: p.User.ID})
	if err != nil {
		h.unavailable(w, r, "list tasks", err)
		return
	}
	out := make([]api.Task, len(rows))
	for i, t := range rows {
		out[i] = taskAPI(store.WorkflowTask{ID: t.ID, RunID: t.RunID, WorkspaceID: t.WorkspaceID, Kind: t.Kind, Title: t.Title,
			Assignees: t.Assignees, FormID: t.FormID, Status: t.Status, CreatedAt: t.CreatedAt}, "")
	}
	httpx.WriteJSON(w, http.StatusOK, map[string][]api.Task{"tasks": out})
}

// visibleTask loads a task its assignees (and the workspace's admins) may see.
func (h *Handlers) visibleTask(w http.ResponseWriter, r *http.Request, id openapi_types.UUID, user store.User) (store.WorkflowTask, string, bool) {
	rows, err := h.Queries.ListWorkflowTasksByID(r.Context(), []pgtype.UUID{pgUUID(id)})
	if err != nil {
		h.unavailable(w, r, "get task", err)
		return store.WorkflowTask{}, "", false
	}
	if len(rows) == 0 {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No such task."})
		return store.WorkflowTask{}, "", false
	}
	t := rows[0]
	task := store.WorkflowTask{ID: t.ID, RunID: t.RunID, WorkspaceID: t.WorkspaceID, Kind: t.Kind, Title: t.Title,
		Assignees: t.Assignees, FormID: t.FormID, Status: t.Status, DoneBy: t.DoneBy, DoneAt: t.DoneAt, Comment: t.Comment,
		SubmissionID: t.SubmissionID, CreatedAt: t.CreatedAt}
	// Assignees and the workspace's admins see a task, while they are in the workspace.
	role, err := h.Queries.GetWorkspaceRole(r.Context(), store.GetWorkspaceRoleParams{WorkspaceID: t.WorkspaceID, UserID: user.ID})
	if err != nil || role == "" || (!slices.Contains(t.Assignees, user.ID) && role != WorkspaceOwner && role != WorkspaceAdmin) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No such task."})
		return task, "", false
	}
	return task, t.DoneByName, true
}

// GetTask implements api.ServerInterface.
func (h *Handlers) GetTask(w http.ResponseWriter, r *http.Request, taskID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	t, doneBy, ok := h.visibleTask(w, r, taskID, p.User)
	if !ok {
		return
	}
	out, err := taskWithForm(r.Context(), h.Queries, t, doneBy)
	if err != nil {
		h.unavailable(w, r, "get task", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// finishTask closes a task, moves its run on and refreshes the task's cards.
func (h *Handlers) finishTask(w http.ResponseWriter, r *http.Request, t store.WorkflowTask, user store.User, status, comment string, submission pgtype.UUID, vars runVars) {
	var done store.WorkflowTask
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		var err error
		done, err = q.FinishWorkflowTask(r.Context(), store.FinishWorkflowTaskParams{
			ID: t.ID, Status: status, DoneBy: user.ID, Comment: comment, SubmissionID: submission,
		})
		if isNoRows(err) {
			return errTaskClosed
		}
		if err != nil {
			return err
		}
		run, err := q.GetWorkflowRunForUpdate(r.Context(), t.RunID)
		if err != nil {
			return err
		}
		if run.Status == "waiting" {
			all := runVars{}
			_ = json.Unmarshal(run.Vars, &all)
			for k, v := range vars {
				all[k] = v
			}
			raw, _ := json.Marshal(all)
			next := "running"
			if status == "rejected" {
				// A rejection ends the run.
				next = "done"
			}
			if err := q.SaveWorkflowRun(r.Context(), store.SaveWorkflowRunParams{ID: run.ID, Step: run.Step, Status: next,
				Vars: raw, WakeAt: time.Now(), Error: ""}); err != nil {
				return err
			}
		}
		msgs, err := q.ListTaskMessages(r.Context(), done.ID)
		if err != nil {
			return err
		}
		for _, m := range msgs {
			full, err := q.GetMessage(r.Context(), store.GetMessageParams(m))
			if err != nil {
				return err
			}
			out := []api.Message{messageAPI(storeMessage(full), full.AuthorName, full.AuthorIsBot)}
			if err := decorate(r.Context(), q, user.ID, out); err != nil {
				return err
			}
			if err := emit(r.Context(), q, events.MessageUpdated, out[0]); err != nil {
				return err
			}
		}
		return nil
	})
	if errors.Is(err, errTaskClosed) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeTaskClosed, Detail: "This task is already done."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "finish task", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, taskAPI(done, user.DisplayName))
}

var errTaskClosed = errors.New("task closed")

// SubmitTask implements api.ServerInterface.
func (h *Handlers) SubmitTask(w http.ResponseWriter, r *http.Request, taskID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.SubmitTaskJSONBody
	if !decode(w, r, &in) {
		return
	}
	t, _, ok := h.visibleTask(w, r, taskID, p.User)
	if !ok {
		return
	}
	if t.Kind != "form" || !slices.Contains(t.Assignees, p.User.ID) {
		forbidden(w, r, httpx.CodeForbidden, "This form is for someone else.")
		return
	}
	if t.Status != "open" {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeTaskClosed, Detail: "This task is already done."})
		return
	}
	f, err := h.Queries.GetForm(r.Context(), t.FormID)
	if err != nil {
		h.unavailable(w, r, "get form", err)
		return
	}
	var fields []api.FormField
	_ = json.Unmarshal(f.Fields, &fields)
	shown, values, problem := answers(r.Context(), h.Queries, t.WorkspaceID, fields, in.Values)
	if problem != "" {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusBadRequest, Code: CodeInvalidForm, Detail: problem})
		return
	}
	raw, _ := json.Marshal(shown)
	s, err := h.Queries.CreateSubmission(r.Context(), store.CreateSubmissionParams{
		FormID: f.ID, WorkspaceID: f.WorkspaceID, UserID: p.User.ID, FormName: f.Name, Answers: raw,
	})
	if err != nil {
		h.unavailable(w, r, "save answers", err)
		return
	}
	vars := runVars{}
	for k, v := range values {
		vars["form."+k] = v
	}
	h.finishTask(w, r, t, p.User, "done", "", s.ID, vars)
}

// DecideTask implements api.ServerInterface.
func (h *Handlers) DecideTask(w http.ResponseWriter, r *http.Request, taskID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.DecideTaskJSONBody
	if !decode(w, r, &in) {
		return
	}
	t, _, ok := h.visibleTask(w, r, taskID, p.User)
	if !ok {
		return
	}
	if t.Kind != "approval" || !slices.Contains(t.Assignees, p.User.ID) {
		forbidden(w, r, httpx.CodeForbidden, "Only the approvers decide.")
		return
	}
	comment := ""
	if in.Comment != nil {
		comment = strings.TrimSpace(*in.Comment)
	}
	if utf8.RuneCountInString(comment) > 1000 {
		badRequest(w, r, "A comment is up to 1000 characters.")
		return
	}
	status := "rejected"
	if in.Approve {
		status = "approved"
	}
	h.finishTask(w, r, t, p.User, status, comment, pgtype.UUID{}, runVars{
		"approval.status":  status,
		"approval.by":      "<@" + uuid(p.User.ID).String() + ">",
		"approval.comment": comment,
	})
}

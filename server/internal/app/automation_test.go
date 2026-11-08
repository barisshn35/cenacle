// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/integrations/signing"
)

// count counts rows matching a query.
func (s *stack) count(query string, args ...any) int {
	s.t.Helper()
	var n int
	if err := s.pool.QueryRow(context.Background(), query, args...).Scan(&n); err != nil {
		s.t.Fatal(err)
	}
	return n
}

// runWorkflows runs the workflow engine until nothing is due.
func (s *stack) runWorkflows() {
	s.t.Helper()
	for range 10 {
		n, err := s.workflows.Run(context.Background())
		if err != nil {
			s.t.Fatal(err)
		}
		if n == 0 {
			return
		}
	}
}

// botMessages counts messages of the workspace's system bot containing text.
func (s *stack) botMessages(text string) int {
	return s.count(`SELECT count(*) FROM messages m JOIN bots b ON b.user_id = m.author_id AND b.is_system
		WHERE m.body LIKE '%' || $1 || '%'`, text)
}

func requestForm(t *testing.T) map[string]any {
	t.Helper()
	return map[string]any{
		"name":        "Time off",
		"description": "Ask for days off",
		"fields": []map[string]any{
			{"id": "reason", "label": "Reason", "kind": "text", "required": true},
			{"id": "days", "label": "Days", "kind": "number", "required": true},
			{"id": "kind", "label": "Kind", "kind": "select", "required": false, "options": []string{"Vacation", "Sick"}},
			{"id": "agree", "label": "I told my team", "kind": "checkbox", "required": true},
		},
	}
}

func TestForms(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-ayse", "Ayşe")
	general := s.general(ayse)
	path := "/api/workspaces/" + s.defaultWS + "/forms"

	if status, _ := problemCode(t, s, http.MethodPost, path, ayse, requestForm(t)); status != http.StatusForbidden {
		t.Errorf("member creates form = %d", status)
	}
	var form api.Form
	if res := s.call(http.MethodPost, path, admin, requestForm(t), &form); res.StatusCode != http.StatusCreated {
		t.Fatalf("create form = %d", res.StatusCode)
	}
	bad := requestForm(t)
	bad["fields"] = []map[string]any{{"id": "x", "label": "X", "kind": "select", "required": true, "options": []string{"only"}}}
	if status, _ := problemCode(t, s, http.MethodPost, path, admin, bad); status != http.StatusBadRequest {
		t.Errorf("one option = %d", status)
	}

	submit := "/api/forms/" + form.Id.String() + "/submissions"
	if status, code := problemCode(t, s, http.MethodPost, submit, ayse, map[string]any{
		"channel_id": general, "values": map[string]any{"reason": "Trip", "days": "two", "agree": "true"},
	}); status != http.StatusBadRequest || code != "invalid_answers" {
		t.Errorf("not a number = %d %s", status, code)
	}
	var msg api.Message
	if res := s.call(http.MethodPost, submit, ayse, map[string]any{
		"channel_id": general, "values": map[string]any{"reason": "Trip", "days": "2", "kind": "Vacation", "agree": "true"},
	}, &msg); res.StatusCode != http.StatusCreated {
		t.Fatalf("submit = %d", res.StatusCode)
	}
	if msg.Submission == nil || msg.Submission.FormName != "Time off" || len(msg.Submission.Answers) != 4 ||
		msg.Submission.Answers[0].Value != "Trip" || msg.Submission.Answers[3].Value != "✓" {
		t.Fatalf("submission = %+v", msg.Submission)
	}
	page := s.timeline(admin, general)
	if last := page[len(page)-1]; last.Submission == nil || last.Submission.User == nil || last.Submission.User.DisplayName != "Ayşe" {
		t.Errorf("timeline submission = %+v", last.Submission)
	}
	var subs struct{ Submissions []api.Submission }
	if res := s.call(http.MethodGet, submit, admin, nil, &subs); res.StatusCode != http.StatusOK || len(subs.Submissions) != 1 {
		t.Errorf("submissions = %d %+v", res.StatusCode, subs)
	}
	if status, _ := problemCode(t, s, http.MethodGet, submit, ayse, nil); status != http.StatusForbidden {
		t.Errorf("member reads submissions = %d", status)
	}
}

func TestManualWorkflowWithFormAndApproval(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-ayse", "Ayşe")
	general := s.general(ayse)
	s.general(admin)
	adminID := s.userID(admin)

	var form api.Form
	s.call(http.MethodPost, "/api/workspaces/"+s.defaultWS+"/forms", admin, requestForm(t), &form)
	var wf api.Workflow
	if res := s.call(http.MethodPost, "/api/workspaces/"+s.defaultWS+"/workflows", admin, map[string]any{
		"name":    "Request time off",
		"trigger": map[string]any{"kind": "manual"},
		"steps": []map[string]any{
			{"id": "ask", "kind": "form", "form_id": form.Id},
			{"id": "tell", "kind": "message", "text": "{{trigger.user}} asks for {{form.days}} days: {{form.reason}}"},
			{"id": "approve", "kind": "approval", "text": "Approve {{form.days}} days for {{trigger.user_name}}?", "approvers": []string{adminID}},
			{"id": "answer", "kind": "dm", "text": "Your request was {{approval.status}} by {{approval.by}}."},
		},
	}, &wf); res.StatusCode != http.StatusCreated {
		t.Fatalf("create workflow = %d", res.StatusCode)
	}

	var shortcuts struct {
		Workflows []api.WorkflowShortcut
		Forms     []api.Form
	}
	s.call(http.MethodGet, "/api/channels/"+general+"/shortcuts", ayse, nil, &shortcuts)
	if len(shortcuts.Workflows) != 1 || len(shortcuts.Forms) != 1 {
		t.Fatalf("shortcuts = %+v", shortcuts)
	}

	var started struct {
		Run  api.WorkflowRun
		Task *api.Task
	}
	if res := s.call(http.MethodPost, "/api/workflows/"+wf.Id.String()+"/runs", ayse, map[string]any{"channel_id": general}, &started); res.StatusCode != http.StatusCreated {
		t.Fatalf("start = %d", res.StatusCode)
	}
	if started.Task == nil || started.Task.Kind != api.TaskKindForm || started.Task.Form == nil || started.Run.Status != api.WorkflowRunStatusWaiting {
		t.Fatalf("started = %+v %+v", started.Run, started.Task)
	}
	task := "/api/tasks/" + started.Task.Id.String()
	if status, _ := problemCode(t, s, http.MethodPost, task+"/submit", admin, map[string]any{"values": map[string]any{}}); status != http.StatusForbidden {
		t.Errorf("someone else fills in = %d", status)
	}
	var done api.Task
	if res := s.call(http.MethodPost, task+"/submit", ayse, map[string]any{
		"values": map[string]any{"reason": "Wedding", "days": "3", "agree": "true"},
	}, &done); res.StatusCode != http.StatusOK || done.Status != api.TaskStatusDone {
		t.Fatalf("submit task = %d %+v", res.StatusCode, done)
	}
	if status, code := problemCode(t, s, http.MethodPost, task+"/submit", ayse, map[string]any{"values": map[string]any{}}); status != http.StatusConflict || code != "task_closed" {
		t.Errorf("again = %d %s", status, code)
	}

	s.runWorkflows()
	if n := s.botMessages("asks for 3 days: Wedding"); n != 1 {
		t.Errorf("channel message = %d", n)
	}
	var tasks struct{ Tasks []api.Task }
	s.call(http.MethodGet, "/api/workspaces/"+s.defaultWS+"/tasks", admin, nil, &tasks)
	if len(tasks.Tasks) != 1 || tasks.Tasks[0].Kind != api.TaskKindApproval || !strings.Contains(tasks.Tasks[0].Title, "Approve 3 days for Ayşe") {
		t.Fatalf("approver's tasks = %+v", tasks.Tasks)
	}
	decide := "/api/tasks/" + tasks.Tasks[0].Id.String() + "/decide"
	if status, _ := problemCode(t, s, http.MethodPost, decide, ayse, map[string]any{"approve": true}); status != http.StatusForbidden && status != http.StatusNotFound {
		t.Errorf("requester decides = %d", status)
	}
	if res := s.call(http.MethodPost, decide, admin, map[string]any{"approve": true, "comment": "Enjoy"}, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("decide = %d", res.StatusCode)
	}
	// The card in the approver's conversation shows the decision.
	if n := s.count(`SELECT count(*) FROM messages m JOIN workflow_tasks t ON t.id = m.task_id WHERE t.status = 'approved'`); n != 1 {
		t.Errorf("approved cards = %d", n)
	}
	s.runWorkflows()
	if n := s.botMessages("Your request was approved by <@" + adminID + ">."); n != 1 {
		t.Errorf("answer = %d", n)
	}
	var runs struct{ Runs []api.WorkflowRun }
	s.call(http.MethodGet, "/api/workflows/"+wf.Id.String()+"/runs", admin, nil, &runs)
	if len(runs.Runs) != 1 || runs.Runs[0].Status != api.WorkflowRunStatusDone || runs.Runs[0].Step != 4 {
		t.Errorf("runs = %+v", runs.Runs)
	}
}

func TestWorkflowRejectionEndsTheRun(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-ayse", "Ayşe")
	general := s.general(ayse)
	var wf api.Workflow
	s.call(http.MethodPost, "/api/workspaces/"+s.defaultWS+"/workflows", admin, map[string]any{
		"name":    "Deploy",
		"trigger": map[string]any{"kind": "manual"},
		"steps": []map[string]any{
			{"id": "approve", "kind": "approval", "text": "Deploy?", "approvers": []string{s.userID(admin)}},
			{"id": "go", "kind": "message", "text": "Deploying now"},
		},
	}, &wf)
	s.call(http.MethodPost, "/api/workflows/"+wf.Id.String()+"/runs", ayse, map[string]any{"channel_id": general}, nil)
	var tasks struct{ Tasks []api.Task }
	s.call(http.MethodGet, "/api/workspaces/"+s.defaultWS+"/tasks", admin, nil, &tasks)
	s.call(http.MethodPost, "/api/tasks/"+tasks.Tasks[0].Id.String()+"/decide", admin, map[string]any{"approve": false}, nil)
	s.runWorkflows()
	if n := s.botMessages("Deploying now"); n != 0 {
		t.Errorf("ran after a rejection: %d", n)
	}
	if n := s.count(`SELECT count(*) FROM workflow_runs WHERE status = 'done'`); n != 1 {
		t.Errorf("finished runs = %d", n)
	}
}

func TestWorkflowTriggers(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-ayse", "Ayşe")
	general := s.general(ayse)
	s.general(admin)
	var ops struct {
		ID string `json:"id"`
	}
	s.call(http.MethodPost, "/api/channels", admin, map[string]any{"name": "Random"}, &ops)
	random := ops.ID
	create := func(body map[string]any) api.Workflow {
		t.Helper()
		var wf api.Workflow
		if res := s.call(http.MethodPost, "/api/workspaces/"+s.defaultWS+"/workflows", admin, body, &wf); res.StatusCode != http.StatusCreated {
			t.Fatalf("create %v = %d", body["name"], res.StatusCode)
		}
		return wf
	}
	create(map[string]any{
		"name": "Deploy words", "trigger": map[string]any{"kind": "keyword", "channel_id": general, "keyword": "deploy"},
		"steps": []map[string]any{{"id": "say", "kind": "message", "text": "Heard: {{trigger.message}}"}},
	})
	create(map[string]any{
		"name": "Eyes", "trigger": map[string]any{"kind": "reaction", "channel_id": general, "emoji": "👀"},
		"steps": []map[string]any{{"id": "say", "kind": "dm", "text": "Thanks for looking, {{trigger.user_name}}"}},
	})
	{
		create(map[string]any{
			"name": "Welcome", "trigger": map[string]any{"kind": "member_joined", "channel_id": random},
			"steps": []map[string]any{{"id": "hi", "kind": "message", "text": "Welcome {{trigger.user}} to {{trigger.channel}}"}},
		})
	}
	// Steps need a person or a channel the trigger gives.
	if status, _ := problemCode(t, s, http.MethodPost, "/api/workspaces/"+s.defaultWS+"/workflows", admin, map[string]any{
		"name": "Bad", "trigger": map[string]any{"kind": "webhook"},
		"steps": []map[string]any{{"id": "f", "kind": "dm", "text": "hi"}},
	}); status != http.StatusBadRequest {
		t.Errorf("dm without a person = %d", status)
	}

	m, _ := s.send(ayse, general, "Please deploy the API", "nonce-wf-1")
	s.send(ayse, general, "nothing to see", "nonce-wf-2")
	s.runWorkflows()
	if n := s.botMessages("Heard: Please deploy the API"); n != 1 {
		t.Errorf("keyword = %d", n)
	}
	// The bot's own message says "deploy" too, and starts nothing.
	if n := s.count(`SELECT count(*) FROM workflow_runs`); n != 1 {
		t.Errorf("runs after keyword = %d", n)
	}
	s.call(http.MethodPut, "/api/channels/"+general+"/messages/"+m.ID+"/reactions/%F0%9F%91%80", ayse, nil, nil)
	s.runWorkflows()
	if n := s.botMessages("Thanks for looking, Ayşe"); n != 1 {
		t.Errorf("reaction = %d", n)
	}
	{
		s.call(http.MethodPost, "/api/channels/"+random+"/join", ayse, nil, nil)
		s.runWorkflows()
		if n := s.botMessages("Welcome <@" + s.userID(ayse) + "> to Random"); n != 1 {
			t.Errorf("member joined = %d", n)
		}
	}
}

func TestScheduledAndWebhookWorkflows(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	general := s.general(admin)

	var received struct {
		body []byte
		sig  string
	}
	hook := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received.body, _ = io.ReadAll(r.Body)
		received.sig = r.Header.Get(signing.Header)
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(hook.Close)

	var sched api.Workflow
	if res := s.call(http.MethodPost, "/api/workspaces/"+s.defaultWS+"/workflows", admin, map[string]any{
		"name": "Stand-up",
		"trigger": map[string]any{"kind": "schedule", "channel_id": general,
			"schedule": map[string]any{"every": "weekday", "time": "09:30", "time_zone": "Europe/Istanbul"}},
		"steps": []map[string]any{{"id": "ask", "kind": "message", "text": "Stand-up time"}},
	}, &sched); res.StatusCode != http.StatusCreated {
		t.Fatalf("schedule = %d", res.StatusCode)
	}
	if sched.NextRunAt == nil || sched.NextRunAt.Before(time.Now()) {
		t.Fatalf("next run = %v", sched.NextRunAt)
	}
	if local := sched.NextRunAt.In(time.FixedZone("TRT", 3*3600)); local.Hour() != 9 || local.Minute() != 30 ||
		local.Weekday() == time.Saturday || local.Weekday() == time.Sunday {
		t.Errorf("next run = %v", local)
	}
	s.runWorkflows()
	if n := s.botMessages("Stand-up time"); n != 0 {
		t.Fatalf("ran early: %d", n)
	}
	if _, err := s.pool.Exec(context.Background(), `UPDATE workflows SET next_run_at = now() - interval '1 minute' WHERE id = $1`, sched.Id); err != nil {
		t.Fatal(err)
	}
	s.runWorkflows()
	if n := s.botMessages("Stand-up time"); n != 1 {
		t.Errorf("scheduled = %d", n)
	}
	if n := s.count(`SELECT count(*) FROM workflows WHERE id = $1 AND next_run_at > now()`, sched.Id); n != 1 {
		t.Errorf("next run not moved on")
	}

	var wh api.Workflow
	if res := s.call(http.MethodPost, "/api/workspaces/"+s.defaultWS+"/workflows", admin, map[string]any{
		"name":    "Alerts",
		"trigger": map[string]any{"kind": "webhook", "channel_id": general},
		"steps": []map[string]any{
			{"id": "wait", "kind": "delay", "minutes": 5},
			{"id": "say", "kind": "message", "text": "{{webhook.service}} is {{webhook.state}}"},
			{"id": "tell", "kind": "http", "url": hook.URL},
		},
	}, &wh); res.StatusCode != http.StatusCreated {
		t.Fatalf("webhook workflow = %d", res.StatusCode)
	}
	if wh.WebhookUrl == nil || wh.Secret == nil {
		t.Fatalf("no address or secret: %+v", wh)
	}
	path := (*wh.WebhookUrl)[strings.Index(*wh.WebhookUrl, "/api/"):]
	req, _ := http.NewRequest(http.MethodPost, s.srv.URL+path, strings.NewReader(`{"service": "api", "state": "down", "count": 3}`))
	req.Header.Set("Content-Type", "application/json")
	res, err := s.client.Do(req)
	if err != nil || res.StatusCode != http.StatusAccepted {
		t.Fatalf("hook = %v %v", res, err)
	}
	_ = res.Body.Close()
	if status, _ := problemCode(t, s, http.MethodPost, "/api/workflow-hooks/cnw_nothing", "", map[string]any{}); status != http.StatusNotFound {
		t.Errorf("unknown hook = %d", status)
	}
	// The delay holds the run back until its time.
	s.runWorkflows()
	if n := s.botMessages("api is down"); n != 0 {
		t.Fatalf("delay skipped: %d", n)
	}
	if _, err := s.pool.Exec(context.Background(), `UPDATE workflow_runs SET wake_at = now() WHERE status = 'running'`); err != nil {
		t.Fatal(err)
	}
	s.runWorkflows()
	if n := s.botMessages("api is down"); n != 1 {
		t.Errorf("webhook message = %d", n)
	}
	if !signing.Verify(*wh.Secret, received.sig, received.body, time.Now(), time.Minute) {
		t.Errorf("outgoing request not signed: %q", received.sig)
	}
	var sent struct {
		Workflow  string            `json:"workflow"`
		Variables map[string]string `json:"variables"`
	}
	_ = json.Unmarshal(received.body, &sent)
	if sent.Workflow != "Alerts" || sent.Variables["webhook.count"] != "3" {
		t.Errorf("outgoing body = %s", received.body)
	}
}

func TestWorkflowIntoAnEncryptedChannelFailsAlone(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	general := s.general(admin)
	var secret channel
	s.call(http.MethodPost, "/api/channels", admin, map[string]any{"name": "Secret"}, &secret)
	steps := func(channelID string) map[string]any {
		return map[string]any{
			"name": "Note " + channelID, "trigger": map[string]any{"kind": "manual"},
			"steps": []map[string]any{{"id": "tell", "kind": "message", "text": "noted in " + channelID, "channel_id": channelID}},
		}
	}
	var into, other api.Workflow
	s.call(http.MethodPost, "/api/workspaces/"+s.defaultWS+"/workflows", admin, steps(secret.ID), &into)
	s.call(http.MethodPost, "/api/workspaces/"+s.defaultWS+"/workflows", admin, steps(general), &other)
	// The channel is encrypted after the workflow was made.
	if _, err := s.pool.Exec(context.Background(), "UPDATE channels SET encrypted = true, mls = true WHERE id = $1", secret.ID); err != nil {
		t.Fatal(err)
	}
	s.call(http.MethodPost, "/api/workflows/"+into.Id.String()+"/runs", admin, map[string]any{"channel_id": general}, nil)
	s.call(http.MethodPost, "/api/workflows/"+other.Id.String()+"/runs", admin, map[string]any{"channel_id": general}, nil)
	s.runWorkflows()
	if n := s.botMessages("noted in " + general); n != 1 {
		t.Errorf("the other run did not go on: %d", n)
	}
	var runs struct{ Runs []api.WorkflowRun }
	s.call(http.MethodGet, "/api/workflows/"+into.Id.String()+"/runs", admin, nil, &runs)
	if len(runs.Runs) != 1 || runs.Runs[0].Status != api.WorkflowRunStatusFailed {
		t.Errorf("runs = %+v", runs.Runs)
	}
	// New workflows cannot write there.
	if status, _ := problemCode(t, s, http.MethodPost, "/api/workspaces/"+s.defaultWS+"/workflows", admin, steps(secret.ID)); status != http.StatusBadRequest {
		t.Errorf("new workflow into it = %d", status)
	}
}

// An approver who left the workspace can no longer see or decide the task.
func TestRemovedApproverLosesTask(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	req := s.user("sub-req", "Requester")
	appr := s.user("sub-appr", "Approver")
	ws := s.newWorkspace(admin, "Approvals")
	var dir struct{ Channels []channel }
	s.call(http.MethodGet, "/api/channels/directory?workspace_id="+ws, admin, nil, &dir)
	ch := dir.Channels[0].ID
	for _, tok := range []string{req, appr} {
		s.call(http.MethodPost, "/api/invites/"+s.invite(admin, ws, map[string]any{})+"/accept", tok, nil, nil)
	}
	s.call(http.MethodPost, "/api/channels/"+ch+"/join", req, nil, nil)
	apprID := s.userID(appr)
	var wf api.Workflow
	if res := s.call(http.MethodPost, "/api/workspaces/"+ws+"/workflows", admin, map[string]any{
		"name": "W", "trigger": map[string]any{"kind": "manual"},
		"steps": []map[string]any{
			{"id": "a", "kind": "approval", "text": "Approve?", "approvers": []string{apprID}},
			{"id": "m", "kind": "message", "text": "after-approval"},
		},
	}, &wf); res.StatusCode != http.StatusCreated {
		t.Fatalf("create workflow = %d", res.StatusCode)
	}
	if res := s.call(http.MethodPost, "/api/workflows/"+wf.Id.String()+"/runs", req, map[string]any{"channel_id": ch}, nil); res.StatusCode != http.StatusCreated {
		t.Fatalf("start = %d", res.StatusCode)
	}
	var tasks struct{ Tasks []api.Task }
	s.call(http.MethodGet, "/api/workspaces/"+ws+"/tasks", appr, nil, &tasks)
	if len(tasks.Tasks) != 1 {
		t.Fatalf("tasks = %+v", tasks.Tasks)
	}
	id := tasks.Tasks[0].Id.String()
	if res := s.call(http.MethodGet, "/api/tasks/"+id, appr, nil, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("assignee reads the task = %d", res.StatusCode)
	}
	if res := s.call(http.MethodDelete, "/api/workspaces/"+ws+"/members/"+apprID, admin, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("remove = %d", res.StatusCode)
	}
	if status, _ := problemCode(t, s, http.MethodGet, "/api/tasks/"+id, appr, nil); status != http.StatusNotFound {
		t.Errorf("removed approver reads the task = %d", status)
	}
	if status, _ := problemCode(t, s, http.MethodPost, "/api/tasks/"+id+"/decide", appr, map[string]any{"approve": true}); status != http.StatusNotFound {
		t.Errorf("removed approver decides = %d", status)
	}
	s.runWorkflows()
	if n := s.botMessages("after-approval"); n != 0 {
		t.Errorf("the run went on: %d", n)
	}
}

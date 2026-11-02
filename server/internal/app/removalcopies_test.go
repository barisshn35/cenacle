// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/chat"
	"github.com/barisshn35/cenacle/server/internal/store"
)

func (s *stack) wake() {
	s.t.Helper()
	if _, err := s.pool.Exec(context.Background(), `UPDATE workflow_runs SET wake_at = now() WHERE status = 'running'`); err != nil {
		s.t.Fatal(err)
	}
}

func (s *stack) spill(reporter, owner, channelID, messageID string) {
	s.t.Helper()
	var rep api.SpillageReport
	if res := s.call(http.MethodPost, "/api/channels/"+channelID+"/messages/"+messageID+"/spillage", reporter,
		map[string]string{"reason": "secret"}, &rep); res.StatusCode != http.StatusCreated {
		s.t.Fatalf("report = %d", res.StatusCode)
	}
	if res := s.call(http.MethodPost, "/api/spillage/"+rep.Id.String()+"/decision", owner,
		map[string]string{"decision": "remove"}, nil); res.StatusCode != http.StatusOK {
		s.t.Fatalf("decide = %d", res.StatusCode)
	}
}

func (s *stack) newWorkflow(admin, ws string, body map[string]any) {
	s.t.Helper()
	if res := s.call(http.MethodPost, "/api/workspaces/"+ws+"/workflows", admin, body, nil); res.StatusCode != http.StatusCreated {
		s.t.Fatalf("create workflow %v = %d", body["name"], res.StatusCode)
	}
}

func TestSpillageReachesWorkflowRuns(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	mert := s.user("sub-m", "Mert")
	general := s.general(ayse)
	s.general(mert)
	later := func(name string, trigger map[string]any, text string) {
		s.newWorkflow(admin, s.defaultWS, map[string]any{"name": name, "trigger": trigger, "steps": []map[string]any{
			{"id": "wait", "kind": "delay", "minutes": 5},
			{"id": "say", "kind": "message", "text": text},
			{"id": "ask", "kind": "approval", "text": "Approve {{trigger.message}}?", "approvers": []string{s.userID(admin)}},
		}})
	}
	later("Keyword", map[string]any{"kind": "keyword", "channel_id": general, "keyword": "spillkw"}, "KW {{trigger.message}}")
	later("Reaction", map[string]any{"kind": "reaction", "channel_id": general, "emoji": "👍"}, "RX {{trigger.message}}")
	s.newWorkflow(admin, s.defaultWS, map[string]any{
		"name": "Now", "trigger": map[string]any{"kind": "keyword", "channel_id": general, "keyword": "spillkw"},
		"steps": []map[string]any{{"id": "say", "kind": "message", "text": "NOW {{trigger.message}}"}},
	})
	m, _ := s.send(ayse, general, "spillkw text SPILL-RUN-1", "wfspill-nonce-1")
	s.call(http.MethodPut, "/api/channels/"+general+"/messages/"+m.ID+"/reactions/%F0%9F%91%8D", mert, nil, nil)
	s.runWorkflows()
	if n := s.botMessages("SPILL-RUN-1"); n != 1 {
		t.Fatalf("posted at once = %d", n)
	}

	s.spill(mert, admin, general, m.ID)
	if n := s.count(`SELECT count(*) FROM workflow_runs WHERE vars::text LIKE '%SPILL-RUN-1%'`); n != 0 {
		t.Errorf("runs still hold the text: %d", n)
	}
	if n := s.count(`SELECT count(*) FROM messages WHERE body LIKE '%SPILL-RUN-1%'`); n != 0 {
		t.Errorf("messages still hold the text: %d", n)
	}
	s.wake()
	s.runWorkflows()
	if n := s.count(`SELECT count(*) FROM messages WHERE body LIKE '%SPILL-RUN-1%'`); n != 0 {
		t.Errorf("waiting runs posted the text: %d", n)
	}
	if n := s.count(`SELECT count(*) FROM workflow_tasks WHERE title LIKE '%SPILL-RUN-1%'`); n != 0 {
		t.Errorf("tasks hold the text: %d", n)
	}
	var incident struct {
		Removed struct {
			WorkflowRuns     int `json:"workflow_runs"`
			WorkflowMessages int `json:"workflow_messages"`
		}
	}
	var raw []byte
	_ = s.pool.QueryRow(context.Background(), `SELECT report FROM spillage_reports WHERE message_ref = $1`, m.ID).Scan(&raw)
	_ = json.Unmarshal(raw, &incident)
	if incident.Removed.WorkflowRuns != 3 || incident.Removed.WorkflowMessages != 1 {
		t.Errorf("incident = %s", raw)
	}
}

func TestDeletedMessageNotPostedByWaitingRun(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	general := s.general(ayse)
	s.newWorkflow(admin, s.defaultWS, map[string]any{
		"name": "Later", "trigger": map[string]any{"kind": "keyword", "channel_id": general, "keyword": "delkw"},
		"steps": []map[string]any{
			{"id": "wait", "kind": "delay", "minutes": 5},
			{"id": "say", "kind": "message", "text": "Heard: {{trigger.message}}"},
		},
	})
	deleted, _ := s.send(ayse, general, "delkw DEL-RUN-1", "wfdel-nonce-1")
	purged, _ := s.send(ayse, general, "delkw DEL-RUN-2", "wfdel-nonce-2")
	s.send(ayse, general, "delkw KEPT-RUN-3", "wfdel-nonce-3")
	s.runWorkflows()
	if res := s.call(http.MethodDelete, "/api/channels/"+general+"/messages/"+deleted.ID, ayse, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("delete = %d", res.StatusCode)
	}
	if n := s.count(`SELECT count(*) FROM workflow_runs WHERE vars::text LIKE '%DEL-RUN-1%'`); n != 0 {
		t.Errorf("the run still holds the deleted text: %d", n)
	}
	// Gone for good (as the purges do), with no word to the runs.
	if _, err := s.pool.Exec(context.Background(), `DELETE FROM messages WHERE id = $1`, purged.ID); err != nil {
		t.Fatal(err)
	}
	s.wake()
	s.runWorkflows()
	if n := s.botMessages("DEL-RUN"); n != 0 {
		t.Errorf("removed text posted: %d", n)
	}
	if n := s.botMessages("Heard: delkw KEPT-RUN-3"); n != 1 {
		t.Errorf("kept message's run = %d", n)
	}
}

func TestSavedReminderOfDeletedMessage(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ayse := s.user("sub-a", "Ayşe")
	mert := s.user("sub-m", "Mert")
	general := s.general(ayse)
	s.general(mert)
	save := func(id string) {
		t.Helper()
		if res := s.call(http.MethodPut, "/api/me/saved/"+id, mert,
			map[string]any{"remind_at": time.Now().Add(2 * time.Hour).Truncate(time.Second)}, nil); res.StatusCode != http.StatusOK {
			t.Fatalf("save = %d", res.StatusCode)
		}
	}
	deleted, _ := s.send(ayse, general, "SAVED-GONE-1", "savedrem-nonce-1")
	purged, _ := s.send(ayse, general, "SAVED-GONE-2", "savedrem-nonce-2")
	kept, _ := s.send(ayse, general, "SAVED-KEPT-3", "savedrem-nonce-3")
	save(deleted.ID)
	save(purged.ID)
	save(kept.ID)
	if res := s.call(http.MethodDelete, "/api/channels/"+general+"/messages/"+deleted.ID, ayse, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("delete = %d", res.StatusCode)
	}
	if _, err := s.pool.Exec(context.Background(), `DELETE FROM messages WHERE id = $1`, purged.ID); err != nil {
		t.Fatal(err)
	}
	s.due()
	if _, err := s.bg.SendDueScheduled(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := s.botMessages("SAVED-GONE"); n != 0 {
		t.Errorf("reminders quoted removed text: %d", n)
	}
	if n := s.botMessages("SAVED-KEPT-3"); n != 1 {
		t.Errorf("reminder of a kept message = %d", n)
	}
}

func TestBurnReminderCarriesNoText(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ayse := s.user("sub-a", "Ayşe")
	mert := s.user("sub-m", "Mert")
	dm, _ := s.open(ayse, s.defaultWS, s.userID(mert))
	var m api.Message
	if res := s.call(http.MethodPost, "/api/channels/"+dm.ID+"/messages", ayse, map[string]any{
		"body": "BURN-SECRET <@" + s.userID(mert) + ">", "nonce": "burnrem-nonce-1", "burn_seconds": 30,
		"priority": "urgent", "persistent": true,
	}, &m); res.StatusCode != http.StatusCreated {
		t.Fatalf("send = %d", res.StatusCode)
	}
	if _, err := s.pool.Exec(context.Background(), "UPDATE messages SET created_at = now() - interval '6 minutes' WHERE id = $1", m.Id); err != nil {
		t.Fatal(err)
	}
	conn := s.connect(mert, "")
	read(t, conn) // hello
	reminders := &chat.Reminders{DB: s.pool, Queries: store.New(s.pool)}
	if n, err := reminders.Run(context.Background()); err != nil || n != 1 {
		t.Fatalf("reminders = %d %v", n, err)
	}
	if ev := read(t, conn); ev.Type != "message.reminder" || strings.Contains(string(ev.Data), "BURN-SECRET") {
		t.Errorf("reminder = %s %s", ev.Type, ev.Data)
	}
}

func TestSpillageRemovalCannotBeRestored(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	owner := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	rev := s.user("sub-r", "Reviewer")
	general := s.general(ayse)
	var low channel
	s.call(http.MethodPost, "/api/channels", owner, map[string]any{"name": "Low"}, &low)
	s.call(http.MethodPost, "/api/channels/"+low.ID+"/join", ayse, nil, nil)
	if res := s.call(http.MethodPut, "/api/workspaces/"+s.defaultWS+"/spillage-reviewers", owner,
		map[string]any{"user_ids": []string{s.userID(rev)}}, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("reviewers = %d", res.StatusCode)
	}
	m, _ := s.send(ayse, general, "RESTORE-MARKER", "spillrestore-nonce-1")
	var f api.Message
	if res := s.call(http.MethodPost, "/api/channels/"+general+"/messages/"+m.ID+"/forward", ayse,
		map[string]any{"channel_id": low.ID, "comment": "fyi"}, &f); res.StatusCode != http.StatusCreated {
		t.Fatalf("forward = %d", res.StatusCode)
	}
	s.spill(ayse, rev, low.ID, f.Id.String())
	if n := s.count(`SELECT count(*) FROM messages WHERE id = $1 AND forward IS NOT NULL`, f.Id.String()); n != 0 {
		t.Error("the removed message keeps its forwarded snapshot")
	}
	if status, _ := problemCode(t, s, http.MethodPost, "/api/channels/"+low.ID+"/messages/"+f.Id.String()+"/restore", owner, nil); status == http.StatusOK {
		t.Error("an owner who is not a reviewer restored a spillage removal")
	}
	if n := s.count(`SELECT count(*) FROM messages WHERE id = $1 AND deleted_at IS NULL`, f.Id.String()); n != 0 {
		t.Error("the removed message is back")
	}
}

func TestHeldReplySurvivesRootPurge(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	mert := s.user("sub-m", "Mert")
	general := s.general(ayse)
	s.general(mert)
	if res := s.call(http.MethodPost, "/api/workspaces/"+s.defaultWS+"/legal-holds", admin,
		map[string]any{"name": "Case", "user_ids": []string{s.userID(mert)}, "channel_ids": []string{}}, nil); res.StatusCode != http.StatusCreated {
		t.Fatalf("hold = %d", res.StatusCode)
	}

	// The root's author deletes it; the purge runs after the restore window.
	root, _ := s.send(ayse, general, "root A", "heldreply-nonce-1")
	reply, _ := s.reply(mert, general, root.ID, "held reply A", "heldreply-nonce-2", false)
	if res := s.call(http.MethodDelete, "/api/channels/"+general+"/messages/"+root.ID, ayse, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("delete = %d", res.StatusCode)
	}
	if _, err := s.pool.Exec(context.Background(), `UPDATE messages SET deleted_at = now() - interval '30 days' WHERE id = $1`, root.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := (chat.Purger{Queries: store.New(s.pool)}).PurgeDeleted(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := s.count(`SELECT count(*) FROM messages WHERE id = $1`, reply.Id.String()); n != 1 {
		t.Error("the deleted-message purge took a held reply")
	}

	// Retention: an old root with a newer held reply.
	old, _ := s.send(ayse, general, "root B", "heldreply-nonce-3")
	old.ID = s.age(old.ID, 40)
	reply, _ = s.reply(mert, general, old.ID, "held reply B", "heldreply-nonce-4", false)
	if res := s.call(http.MethodPut, "/api/workspaces/"+s.defaultWS+"/compliance", admin, map[string]any{
		"retention_days": 30, "default_classification": nil, "classifications": []any{}, "attributes": []any{},
	}, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("retention = %d", res.StatusCode)
	}
	s.purgeExpired()
	if n := s.count(`SELECT count(*) FROM messages WHERE id = $1`, reply.Id.String()); n != 1 {
		t.Error("the retention purge took a held reply")
	}
}

func TestWorkflowDoesNotReachRemovedMember(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	carol := s.user("sub-carol", "Carol")
	dave := s.user("sub-dave", "Dave")
	ws := s.newWorkspace(admin, "Ops2")
	var dir struct{ Channels []channel }
	s.call(http.MethodGet, "/api/channels/directory?workspace_id="+ws, admin, nil, &dir)
	ch := dir.Channels[0].ID
	for _, tok := range []string{carol, dave} {
		s.call(http.MethodPost, "/api/invites/"+s.invite(admin, ws, map[string]any{})+"/accept", tok, nil, nil)
		s.call(http.MethodPost, "/api/channels/"+ch+"/join", tok, nil, nil)
	}
	carolID := s.userID(carol)
	s.newWorkflow(admin, ws, map[string]any{
		"name": "Copy", "trigger": map[string]any{"kind": "keyword", "channel_id": ch, "keyword": "release"},
		"steps": []map[string]any{{"id": "copy", "kind": "dm", "to": carolID, "text": "Copy: {{trigger.message}}"}},
	})
	s.newWorkflow(admin, ws, map[string]any{
		"name": "Ask", "trigger": map[string]any{"kind": "keyword", "channel_id": ch, "keyword": "release"},
		"steps": []map[string]any{{"id": "ask", "kind": "approval", "text": "OK?", "approvers": []string{carolID}}},
	})
	if res := s.call(http.MethodDelete, "/api/workspaces/"+ws+"/members/"+carolID, admin, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("remove = %d", res.StatusCode)
	}
	s.send(dave, ch, "release at 9 REMOVED-DM-1", "wfremoved-nonce-1")
	s.runWorkflows()
	if n := s.count(`SELECT count(*) FROM channel_members cm JOIN channels c ON c.id = cm.channel_id
		WHERE cm.user_id = $1 AND c.workspace_id = $2`, carolID, ws); n != 0 {
		t.Errorf("the removed member was added back to %d channels", n)
	}
	if n := s.botMessages("REMOVED-DM-1"); n != 0 {
		t.Errorf("sent to the removed member: %d", n)
	}
	if n := s.count(`SELECT count(*) FROM workflow_runs WHERE workspace_id = $1 AND status = 'failed'`, ws); n != 2 {
		t.Errorf("failed runs = %d", n)
	}
}

func TestEventReminderAfterLosingTheChannel(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	s.general(ayse)
	var board channel
	s.call(http.MethodPost, "/api/channels", admin, map[string]any{"name": "Board", "visibility": "private"}, &board)
	ayseID := s.userID(ayse)
	s.call(http.MethodPost, "/api/channels/"+board.ID+"/members", admin, map[string]string{"user_id": ayseID}, nil)
	start := time.Now().Add(2 * time.Hour).Truncate(time.Second)
	event := func(title string) api.Event {
		t.Helper()
		var e api.Event
		if res := s.call(http.MethodPost, "/api/workspaces/"+s.defaultWS+"/events", admin, map[string]any{
			"title": title, "starts_at": start, "ends_at": start.Add(time.Hour), "channel_id": board.ID,
		}, &e); res.StatusCode != http.StatusCreated {
			t.Fatalf("event = %d", res.StatusCode)
		}
		if res := s.call(http.MethodPut, "/api/events/"+e.Id.String()+"/rsvp", ayse, map[string]any{"status": "going"}, nil); res.StatusCode != http.StatusOK {
			t.Fatalf("rsvp = %d", res.StatusCode)
		}
		return e
	}
	moved := event("Planning")
	event("Budget")
	if res := s.call(http.MethodDelete, "/api/channels/"+board.ID+"/members/"+ayseID, admin, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("remove = %d", res.StatusCode)
	}
	if res := s.call(http.MethodPut, "/api/events/"+moved.Id.String(), admin, map[string]any{
		"title": "Renamed-EV", "starts_at": start.Add(time.Hour), "ends_at": start.Add(2 * time.Hour), "channel_id": board.ID,
	}, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("update = %d", res.StatusCode)
	}
	for _, sc := range s.scheduled(ayse) {
		if strings.Contains(sc.Body, "Renamed-EV") {
			t.Errorf("rescheduled for an outsider: %+v", sc)
		}
	}
	s.due()
	if _, err := s.bg.SendDueScheduled(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := s.botMessages("Renamed-EV") + s.botMessages("Budget starts"); n != 0 {
		t.Errorf("reminders reached an outsider: %d", n)
	}
}

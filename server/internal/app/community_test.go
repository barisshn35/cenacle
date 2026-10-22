// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/barisshn35/cenacle/server/internal/api"
)

func TestSlowModeAndTimeouts(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-ayse", "Ayşe")
	general := s.general(ayse)
	s.general(admin)
	path := "/api/channels/" + general + "/messages"

	// Slow mode: members wait; the workspace's admins do not.
	if res := s.call(http.MethodPatch, "/api/channels/"+general, admin, map[string]any{"slow_mode_seconds": 60}, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("set slow mode = %d", res.StatusCode)
	}
	if _, res := s.send(ayse, general, "first", "nonce-slow-1"); res.StatusCode != http.StatusCreated {
		t.Fatalf("first = %d", res.StatusCode)
	}
	if status, code := problemCode(t, s, http.MethodPost, path, ayse, map[string]any{"body": "second", "nonce": "nonce-slow-2"}); status != http.StatusTooManyRequests || code != "slow_mode" {
		t.Errorf("second = %d %s", status, code)
	}
	s.send(admin, general, "admin 1", "nonce-slow-3")
	if _, res := s.send(admin, general, "admin 2", "nonce-slow-4"); res.StatusCode != http.StatusCreated {
		t.Errorf("admin in slow mode = %d", res.StatusCode)
	}
	s.call(http.MethodPatch, "/api/channels/"+general, admin, map[string]any{"slow_mode_seconds": 0}, nil)

	// A timeout stops messages and reactions; admins cannot be timed out.
	timeout := "/api/workspaces/" + s.defaultWS + "/members/" + s.userID(ayse) + "/timeout"
	if res := s.call(http.MethodPut, timeout, admin, map[string]any{"until": time.Now().Add(time.Hour)}, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("timeout = %d", res.StatusCode)
	}
	if status, code := problemCode(t, s, http.MethodPost, path, ayse, map[string]any{"body": "hi", "nonce": "nonce-to-1"}); status != http.StatusForbidden || code != "timed_out" {
		t.Errorf("send while timed out = %d %s", status, code)
	}
	m, _ := s.send(admin, general, "react to me", "nonce-to-2")
	if status, code := problemCode(t, s, http.MethodPut, path+"/"+m.ID+"/reactions/%F0%9F%91%8D", ayse, nil); status != http.StatusForbidden || code != "timed_out" {
		t.Errorf("react while timed out = %d %s", status, code)
	}
	var ws []api.Workspace
	var list struct{ Workspaces []api.Workspace }
	s.call(http.MethodGet, "/api/workspaces", ayse, nil, &list)
	ws = list.Workspaces
	if len(ws) == 0 || ws[0].TimeoutUntil == nil {
		t.Errorf("workspace timeout = %+v", ws)
	}
	if status, _ := problemCode(t, s, http.MethodPut, "/api/workspaces/"+s.defaultWS+"/members/"+s.userID(admin)+"/timeout", admin,
		map[string]any{"until": time.Now().Add(time.Hour)}); status != http.StatusForbidden {
		t.Errorf("timing out an admin = %d", status)
	}
	if status, _ := problemCode(t, s, http.MethodPut, timeout, ayse, map[string]any{"until": nil}); status != http.StatusForbidden {
		t.Errorf("member ending a timeout = %d", status)
	}
	s.call(http.MethodPut, timeout, admin, map[string]any{"until": nil}, nil)
	if _, res := s.send(ayse, general, "back", "nonce-to-3"); res.StatusCode != http.StatusCreated {
		t.Errorf("after the timeout = %d", res.StatusCode)
	}
}

func TestAutomodAndReports(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-ayse", "Ayşe")
	mert := s.user("sub-mert", "Mert")
	general := s.general(ayse)
	s.general(mert)
	s.general(admin)
	rules := "/api/workspaces/" + s.defaultWS + "/automod"

	var block, flag api.AutomodRule
	if res := s.call(http.MethodPost, rules, admin, map[string]any{
		"name": "No spam", "kind": "keywords", "words": []string{"kazan*", "bedava"}, "action": "block",
	}, &block); res.StatusCode != http.StatusCreated {
		t.Fatalf("create rule = %d", res.StatusCode)
	}
	s.call(http.MethodPost, rules, admin, map[string]any{
		"name": "Links", "kind": "links", "allowed_domains": []string{"example.com"}, "action": "flag",
	}, &flag)
	if status, _ := problemCode(t, s, http.MethodPost, rules, ayse, map[string]any{"name": "x", "kind": "mentions", "max_mentions": 2, "action": "block"}); status != http.StatusForbidden {
		t.Errorf("member creating a rule = %d", status)
	}

	path := "/api/channels/" + general + "/messages"
	// Case and accents do not matter; a trailing * matches beginnings.
	if status, code := problemCode(t, s, http.MethodPost, path, ayse, map[string]any{"body": "Hemen KAZANIN!", "nonce": "nonce-am-1"}); status != http.StatusBadRequest || code != "automod_blocked" {
		t.Errorf("blocked = %d %s", status, code)
	}
	if _, res := s.send(ayse, general, "kazanç değil, kazak", "nonce-am-2"); res.StatusCode != http.StatusBadRequest {
		t.Errorf("prefix kazan* on kazanç = %d", res.StatusCode)
	}
	if _, res := s.send(ayse, general, "Bir kazak aldım", "nonce-am-3"); res.StatusCode != http.StatusCreated {
		t.Errorf("unrelated word = %d", res.StatusCode)
	}
	// Admins are exempt by default.
	if _, res := s.send(admin, general, "bedava kahve", "nonce-am-4"); res.StatusCode != http.StatusCreated {
		t.Errorf("admin exempt = %d", res.StatusCode)
	}
	// Flagged: sent, and reported by AutoMod.
	link, res := s.send(ayse, general, "bakın https://evil.test/x ve https://docs.example.com/a", "nonce-am-5")
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("flagged message = %d", res.StatusCode)
	}
	other, _ := s.send(ayse, general, "kaba bir söz", "nonce-am-6")
	if res := s.call(http.MethodPost, path+"/"+other.ID+"/report", mert, map[string]any{"reason": "Kaba"}, nil); res.StatusCode != http.StatusNoContent {
		t.Errorf("report = %d", res.StatusCode)
	}
	s.call(http.MethodPost, path+"/"+other.ID+"/report", mert, map[string]any{"reason": "Again"}, nil)
	if status, _ := problemCode(t, s, http.MethodPost, path+"/"+other.ID+"/report", ayse, map[string]any{}); status != http.StatusBadRequest {
		t.Errorf("reporting one's own = %d", status)
	}

	var queue struct{ Reports []api.Report }
	s.call(http.MethodGet, "/api/workspaces/"+s.defaultWS+"/reports", admin, nil, &queue)
	if len(queue.Reports) != 2 {
		t.Fatalf("queue = %+v", queue.Reports)
	}
	var auto, human api.Report
	for _, r := range queue.Reports {
		if r.Reporter == nil {
			auto = r
		} else {
			human = r
		}
	}
	if auto.RuleName != "Links" || auto.Message.Id.String() != link.ID || human.Reason != "Kaba" || human.Reporter.DisplayName != "Mert" {
		t.Errorf("reports = %+v / %+v", auto, human)
	}
	if status, _ := problemCode(t, s, http.MethodGet, "/api/workspaces/"+s.defaultWS+"/reports", mert, nil); status != http.StatusForbidden {
		t.Errorf("member reading the queue = %d", status)
	}
	// Delete the reported message; time the other author out.
	var done api.Report
	s.call(http.MethodPost, "/api/reports/"+human.Id.String()+"/resolve", admin, map[string]any{"action": "delete"}, &done)
	if done.Action != "deleted" || done.Status != "resolved" {
		t.Errorf("resolved = %+v", done)
	}
	for _, m := range s.timeline(mert, general) {
		if m.Id.String() == other.ID {
			t.Error("the deleted message is still there")
		}
	}
	s.call(http.MethodPost, "/api/reports/"+auto.Id.String()+"/resolve", admin, map[string]any{"action": "timeout", "timeout_minutes": 30}, &done)
	if status, code := problemCode(t, s, http.MethodPost, path, ayse, map[string]any{"body": "x", "nonce": "nonce-am-7"}); status != http.StatusForbidden || code != "timed_out" {
		t.Errorf("after a timeout resolution = %d %s", status, code)
	}
	s.call(http.MethodGet, "/api/workspaces/"+s.defaultWS+"/reports", admin, nil, &queue)
	if len(queue.Reports) != 0 {
		t.Errorf("open reports left = %d", len(queue.Reports))
	}
	s.call(http.MethodGet, "/api/workspaces/"+s.defaultWS+"/reports?status=closed", admin, nil, &queue)
	// Mert's second report of the same message was not counted.
	if len(queue.Reports) != 2 {
		t.Errorf("closed reports = %d", len(queue.Reports))
	}
	if res := s.call(http.MethodDelete, "/api/automod/"+block.Id.String(), admin, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Errorf("delete rule = %d", res.StatusCode)
	}
}

func TestPollsAndForums(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-ayse", "Ayşe")
	mert := s.user("sub-mert", "Mert")
	general := s.general(ayse)
	s.general(mert)
	path := "/api/channels/" + general + "/messages"

	var m api.Message
	if res := s.call(http.MethodPost, path, ayse, map[string]any{"body": "Öğle yemeği?", "nonce": "nonce-poll-1",
		"poll": map[string]any{"options": []string{"Pizza", "Döner", "Salata"}}}, &m); res.StatusCode != http.StatusCreated || m.Poll == nil {
		t.Fatalf("poll = %d %+v", res.StatusCode, m.Poll)
	}
	if status, _ := problemCode(t, s, http.MethodPost, path, ayse, map[string]any{"body": "x", "nonce": "nonce-poll-2",
		"poll": map[string]any{"options": []string{"only one"}}}); status != http.StatusBadRequest {
		t.Errorf("one option = %d", status)
	}
	opts := m.Poll.Options
	votes := path + "/" + m.Id.String() + "/poll/votes"
	var p api.Poll
	s.call(http.MethodPut, votes, mert, map[string]any{"option_ids": []string{opts[1].Id.String()}}, &p)
	if p.Voters != 1 || p.Options[1].Votes != 1 || !p.Options[1].Me || p.Options[1].Voters == nil || len(*p.Options[1].Voters) != 1 {
		t.Errorf("vote = %+v", p)
	}
	if status, _ := problemCode(t, s, http.MethodPut, votes, mert, map[string]any{"option_ids": []string{opts[0].Id.String(), opts[1].Id.String()}}); status != http.StatusBadRequest {
		t.Errorf("two options in a single-choice poll = %d", status)
	}
	// Changing the vote replaces it; the reader sees their own choice.
	s.call(http.MethodPut, votes, mert, map[string]any{"option_ids": []string{opts[0].Id.String()}}, &p)
	var seen api.Message
	s.call(http.MethodGet, path+"/"+m.Id.String(), ayse, nil, &seen)
	if seen.Poll.Options[0].Votes != 1 || seen.Poll.Options[1].Votes != 0 || seen.Poll.Options[0].Me {
		t.Errorf("as Ayşe = %+v", seen.Poll.Options)
	}
	if status, _ := problemCode(t, s, http.MethodPost, path+"/"+m.Id.String()+"/poll/close", mert, nil); status != http.StatusForbidden {
		t.Errorf("others closing = %d", status)
	}
	s.call(http.MethodPost, path+"/"+m.Id.String()+"/poll/close", ayse, nil, &p)
	if !p.Closed {
		t.Error("not closed")
	}
	if status, code := problemCode(t, s, http.MethodPut, votes, mert, map[string]any{"option_ids": []string{}}); status != http.StatusConflict || code != "poll_closed" {
		t.Errorf("vote after closing = %d %s", status, code)
	}

	// Forums: posts have titles and the forum's tags; replies have neither.
	var forum channel
	if res := s.call(http.MethodPost, "/api/channels", admin, map[string]any{"name": "Ideas", "kind": "forum"}, &forum); res.StatusCode != http.StatusCreated {
		t.Fatalf("forum = %d", res.StatusCode)
	}
	s.call(http.MethodPatch, "/api/channels/"+forum.ID, admin, map[string]any{"forum_tags": []string{"UX", "Backend"}}, nil)
	s.call(http.MethodPost, "/api/channels/"+forum.ID+"/join", ayse, nil, nil)
	fpath := "/api/channels/" + forum.ID + "/messages"
	if status, _ := problemCode(t, s, http.MethodPost, fpath, ayse, map[string]any{"body": "no title", "nonce": "nonce-forum-1"}); status != http.StatusBadRequest {
		t.Errorf("post without title = %d", status)
	}
	if status, _ := problemCode(t, s, http.MethodPost, fpath, ayse, map[string]any{"body": "x", "nonce": "nonce-forum-2", "title": "T", "tags": []string{"Ops"}}); status != http.StatusBadRequest {
		t.Errorf("unknown tag = %d", status)
	}
	var post api.Message
	s.call(http.MethodPost, fpath, ayse, map[string]any{"body": "Dark mode everywhere", "nonce": "nonce-forum-3", "title": "Dark mode", "tags": []string{"ux"}}, &post)
	if post.Title == nil || *post.Title != "Dark mode" || post.Tags == nil || (*post.Tags)[0] != "ux" {
		t.Errorf("post = %+v %+v", post.Title, post.Tags)
	}
	if _, res := s.reply(admin, forum.ID, post.Id.String(), "+1", "nonce-forum-4", false); res.StatusCode != http.StatusCreated {
		t.Errorf("reply in a forum = %d", res.StatusCode)
	}
	if status, _ := problemCode(t, s, http.MethodPost, path, ayse, map[string]any{"body": "x", "nonce": "nonce-forum-5", "title": "No"}); status != http.StatusBadRequest {
		t.Errorf("title outside a forum = %d", status)
	}
}

func TestEventsWelcomeBannerTerms(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-ayse", "Ayşe")
	general := s.general(ayse)
	s.general(admin)

	// Events: going schedules a reminder; canceling removes it.
	var e api.Event
	start := time.Now().Add(2 * time.Hour).Truncate(time.Second)
	if res := s.call(http.MethodPost, "/api/workspaces/"+s.defaultWS+"/events", ayse, map[string]any{
		"title": "Sprint review", "starts_at": start, "ends_at": start.Add(time.Hour), "channel_id": general,
	}, &e); res.StatusCode != http.StatusCreated || !e.CanEdit {
		t.Fatalf("event = %d %+v", res.StatusCode, e)
	}
	found := false
	for _, m := range s.timeline(admin, general) {
		found = found || strings.Contains(m.Body, "Sprint review")
	}
	if !found {
		t.Error("the event was not announced in its channel")
	}
	s.call(http.MethodPut, "/api/events/"+e.Id.String()+"/rsvp", admin, map[string]any{"status": "going"}, &e)
	if len(e.Going) != 1 || e.Me == nil || *e.Me != "going" || !e.CanEdit {
		t.Errorf("rsvp = %+v", e)
	}
	if list := s.scheduled(admin); len(list) != 1 || !strings.Contains(list[0].Body, "Sprint review") {
		t.Errorf("reminder = %+v", list)
	}
	if res := s.call(http.MethodDelete, "/api/events/"+e.Id.String(), admin, nil, nil); res.StatusCode != http.StatusNoContent {
		status := res.StatusCode
		t.Errorf("admin cancels = %d", status)
	}
	if len(s.scheduled(admin)) != 0 {
		t.Error("the reminder was not canceled")
	}
	var events struct{ Events []api.Event }
	s.call(http.MethodGet, "/api/workspaces/"+s.defaultWS+"/events", ayse, nil, &events)
	if len(events.Events) != 0 {
		t.Errorf("canceled events listed: %d", len(events.Events))
	}

	// Welcome: suggested channels are joined when the welcome is closed.
	var extra channel
	s.call(http.MethodPost, "/api/channels", admin, map[string]any{"name": "Help"}, &extra)
	if res := s.call(http.MethodPut, "/api/workspaces/"+s.defaultWS+"/welcome", admin, map[string]any{
		"message": "Hoş geldiniz!", "rules": []string{"Kibar olun"}, "channel_ids": []string{extra.ID},
	}, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("welcome = %d", res.StatusCode)
	}
	var list struct{ Workspaces []api.Workspace }
	s.call(http.MethodGet, "/api/workspaces", ayse, nil, &list)
	if list.Workspaces[0].NeedsOnboarding == nil || !*list.Workspaces[0].NeedsOnboarding {
		t.Errorf("needs onboarding = %v", list.Workspaces[0].NeedsOnboarding)
	}
	s.call(http.MethodPost, "/api/workspaces/"+s.defaultWS+"/onboarded", ayse, map[string]any{"join_channel_ids": []string{extra.ID}}, nil)
	if s.channelID(ayse, "Help") == "" {
		t.Error("the suggested channel was not joined")
	}
	s.call(http.MethodGet, "/api/workspaces", ayse, nil, &list)
	if *list.Workspaces[0].NeedsOnboarding {
		t.Error("still onboarding")
	}

	// Banner: instance administrators only.
	if status, _ := problemCode(t, s, http.MethodPut, "/api/banner", ayse, map[string]any{"text": "x", "level": "info"}); status != http.StatusForbidden {
		t.Errorf("member banner = %d", status)
	}
	s.call(http.MethodPut, "/api/banner", admin, map[string]any{"text": "Bakım 22:00", "level": "warning"}, nil)
	var banner struct{ Banner *api.Banner }
	s.call(http.MethodGet, "/api/banner", ayse, nil, &banner)
	if banner.Banner == nil || banner.Banner.Text != "Bakım 22:00" || !banner.Banner.Dismissible {
		t.Errorf("banner = %+v", banner.Banner)
	}

	// Terms: everyone accepts them before anything else.
	var terms api.Terms
	if res := s.call(http.MethodPut, "/api/terms", admin, map[string]any{"text": "Kurallar"}, &terms); res.StatusCode != http.StatusOK {
		t.Fatalf("terms = %d", res.StatusCode)
	}
	if status, code := problemCode(t, s, http.MethodGet, "/api/channels", ayse, nil); status != http.StatusForbidden || code != "terms_required" {
		t.Errorf("before accepting = %d %s", status, code)
	}
	if res := s.call(http.MethodGet, "/api/channels", admin, nil, nil); res.StatusCode != http.StatusOK {
		t.Errorf("the author of the terms = %d", res.StatusCode)
	}
	var state struct {
		Terms    *api.Terms
		Accepted bool
	}
	s.call(http.MethodGet, "/api/terms", ayse, nil, &state)
	if state.Terms == nil || state.Accepted {
		t.Errorf("terms state = %+v", state)
	}
	if status, _ := problemCode(t, s, http.MethodPost, "/api/terms/accept", ayse, map[string]any{"terms_id": general}); status != http.StatusConflict {
		t.Errorf("accepting other terms = %d", status)
	}
	s.call(http.MethodPost, "/api/terms/accept", ayse, map[string]any{"terms_id": terms.Id}, nil)
	if res := s.call(http.MethodGet, "/api/channels", ayse, nil, nil); res.StatusCode != http.StatusOK {
		t.Errorf("after accepting = %d", res.StatusCode)
	}
}

func TestPlaybooks(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-ayse", "Ayşe")
	general := s.general(ayse)
	s.general(admin)

	var pb api.Playbook
	body := map[string]any{"name": "Incident", "checklists": []map[string]any{
		{"title": "Triage", "items": []map[string]any{{"title": "Open a channel"}, {"title": "Page on-call"}}},
		{"title": "Close", "items": []map[string]any{{"title": "Write the postmortem"}}},
	}}
	if status, _ := problemCode(t, s, http.MethodPost, "/api/workspaces/"+s.defaultWS+"/playbooks", ayse, body); status != http.StatusForbidden {
		t.Errorf("member creates = %d", status)
	}
	if res := s.call(http.MethodPost, "/api/workspaces/"+s.defaultWS+"/playbooks", admin, body, &pb); res.StatusCode != http.StatusCreated || len(pb.Checklists) != 2 {
		t.Fatalf("playbook = %d %+v", res.StatusCode, pb)
	}
	var run api.Run
	if res := s.call(http.MethodPost, "/api/playbooks/"+pb.Id.String()+"/runs", ayse, map[string]any{"channel_id": general, "name": "DB outage"}, &run); res.StatusCode != http.StatusCreated {
		t.Fatalf("run = %d", res.StatusCode)
	}
	if run.Status != "active" || run.Owner.DisplayName != "Ayşe" || len(run.Checklists[0].Items) != 2 {
		t.Errorf("run = %+v", run)
	}
	s.call(http.MethodPatch, "/api/runs/"+run.Id.String()+"/items", ayse, map[string]any{"checklist": 0, "item": 1, "done": true}, &run)
	if run.Checklists[0].Items[1].DoneAt == nil || run.Checklists[0].Items[1].DoneBy.String() != s.userID(ayse) {
		t.Errorf("checked = %+v", run.Checklists[0].Items[1])
	}
	if status, _ := problemCode(t, s, http.MethodPatch, "/api/runs/"+run.Id.String()+"/items", ayse, map[string]any{"checklist": 5, "item": 0, "done": true}); status != http.StatusBadRequest {
		t.Errorf("unknown item = %d", status)
	}
	var runs struct{ Runs []api.Run }
	s.call(http.MethodGet, "/api/channels/"+general+"/runs", admin, nil, &runs)
	if len(runs.Runs) != 1 {
		t.Errorf("runs = %d", len(runs.Runs))
	}
	s.call(http.MethodPost, "/api/runs/"+run.Id.String()+"/finish", ayse, nil, &run)
	if run.Status != "finished" || run.FinishedAt == nil {
		t.Errorf("finished = %+v", run)
	}
	if status, code := problemCode(t, s, http.MethodPatch, "/api/runs/"+run.Id.String()+"/items", ayse, map[string]any{"checklist": 0, "item": 0, "done": true}); status != http.StatusConflict || code != "run_finished" {
		t.Errorf("change a finished run = %d %s", status, code)
	}
	var started, finished bool
	for _, m := range s.timeline(admin, general) {
		started = started || strings.Contains(m.Body, "Started **DB outage**")
		finished = finished || strings.Contains(m.Body, "Finished **DB outage**")
	}
	if !started || !finished {
		t.Errorf("channel messages: started %v finished %v", started, finished)
	}
}

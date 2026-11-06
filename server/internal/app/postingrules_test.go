// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
)

// moderate sets up the rules of moderation the tests below are held to:
// only admins mention everyone, and AutoMod blocks "bedava".
func (s *stack) moderate(admin string) {
	s.t.Helper()
	if res := s.call(http.MethodPut, "/api/workspaces/"+s.defaultWS+"/permissions", admin, map[string]any{
		"permissions": map[string][]string{"broadcast_mentions": {"admin"}},
	}, nil); res.StatusCode != http.StatusOK {
		s.t.Fatalf("set scheme = %d", res.StatusCode)
	}
	if res := s.call(http.MethodPost, "/api/workspaces/"+s.defaultWS+"/automod", admin, map[string]any{
		"name": "No spam", "kind": "keywords", "words": []string{"bedava"}, "action": "block",
	}, nil); res.StatusCode != http.StatusCreated {
		s.t.Fatalf("create rule = %d", res.StatusCode)
	}
}

// timeOut pauses a member's messages for an hour (until: nil ends it).
func (s *stack) timeOut(admin, user string, until any) {
	s.t.Helper()
	if res := s.call(http.MethodPut, "/api/workspaces/"+s.defaultWS+"/members/"+user+"/timeout", admin,
		map[string]any{"until": until}, nil); res.StatusCode != http.StatusNoContent {
		s.t.Fatalf("timeout = %d", res.StatusCode)
	}
}

// Scheduled messages meet the posting rules when scheduled and again when sent.
func TestScheduledMessagesFollowPostingRules(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ctx := context.Background()
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	mert := s.user("sub-m", "Mert")
	general := s.general(ayse)
	s.general(mert)
	path := "/api/channels/" + general + "/scheduled"
	later := time.Now().Add(time.Hour)
	// Mentioning everyone is allowed when scheduled, refused when sent once
	// the scheme no longer lets members do it.
	if res := s.call(http.MethodPost, path, mert, map[string]any{"body": "@channel duyuru", "send_at": later}, nil); res.StatusCode != http.StatusCreated {
		t.Fatalf("schedule a broadcast = %d", res.StatusCode)
	}
	s.moderate(admin)

	for body, want := range map[string]string{"@channel toplantı": "broadcast_not_allowed", "bedava kahve": "automod_blocked"} {
		if _, code := problemCode(t, s, http.MethodPost, path, ayse, map[string]any{"body": body, "send_at": later}); code != want {
			t.Errorf("scheduling %q = %s", body, code)
		}
	}
	if res := s.call(http.MethodPost, path, ayse, map[string]any{"body": "yarın görüşürüz", "send_at": later}, nil); res.StatusCode != http.StatusCreated {
		t.Fatalf("schedule = %d", res.StatusCode)
	}
	s.timeOut(admin, s.userID(ayse), time.Now().Add(time.Hour))
	if _, code := problemCode(t, s, http.MethodPost, path, ayse, map[string]any{"body": "hâlâ buradayım", "send_at": later}); code != "timed_out" {
		t.Errorf("scheduling while timed out = %s", code)
	}
	s.due()
	if _, err := s.bg.SendDueScheduled(ctx); err != nil {
		t.Fatal(err)
	}
	if n := s.count("SELECT count(*) FROM messages WHERE body IN ('yarın görüşürüz', '@channel duyuru')"); n != 0 {
		t.Errorf("%d refused scheduled messages were posted", n)
	}
	if n := s.count("SELECT count(*) FROM scheduled_messages WHERE status = 'failed' AND error <> ''"); n != 2 {
		t.Errorf("failed scheduled messages = %d", n)
	}
	if n := s.count("SELECT count(*) FROM message_mentions WHERE kind = 'channel'"); n != 0 {
		t.Errorf("channel mentions = %d", n)
	}
}

// A scheduled message that can no longer be sent (its conversation was
// encrypted since) fails alone: the rest of the batch goes out.
func TestScheduledMessageFailsAlone(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ctx := context.Background()
	ayse := s.user("sub-a", "Ayşe")
	mert := s.user("sub-m", "Mert")
	zeynep := s.user("sub-z", "Zeynep")
	general := s.general(zeynep)
	dm, status := s.open(ayse, s.defaultWS, s.userID(mert))
	if status != http.StatusCreated && status != http.StatusOK {
		t.Fatalf("open = %d", status)
	}
	later := time.Now().Add(time.Hour)
	s.call(http.MethodPost, "/api/channels/"+dm.ID+"/scheduled", ayse, map[string]any{"body": "sonra yazarım", "send_at": later}, nil)
	s.call(http.MethodPost, "/api/channels/"+general+"/scheduled", zeynep, map[string]any{"body": "günaydın herkese", "send_at": later}, nil)
	if _, err := s.pool.Exec(ctx, "UPDATE channels SET encrypted = true, mls = true WHERE id = $1", dm.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE scheduled_messages SET send_at = now() - CASE WHEN body = 'sonra yazarım'
		THEN interval '2 minutes' ELSE interval '1 minute' END`); err != nil {
		t.Fatal(err)
	}
	if n, err := s.bg.SendDueScheduled(ctx); err != nil || n != 2 {
		t.Fatalf("sent %d, %v", n, err)
	}
	if n := s.count("SELECT count(*) FROM messages WHERE body = 'günaydın herkese'"); n != 1 {
		t.Errorf("the healthy message was posted %d times", n)
	}
	if n := s.count("SELECT count(*) FROM scheduled_messages WHERE body = 'sonra yazarım' AND status = 'failed'"); n != 1 {
		t.Error("the message for the encrypted conversation did not fail")
	}
}

// A command's answer in the channel is held to AutoMod like the caller's own message.
func TestCommandAnswersFollowAutomod(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	general := s.general(ayse)
	s.moderate(admin)
	b := s.newBot(admin, "Echo")
	rv := newReceiver(t)
	if res := s.call(http.MethodPost, "/api/bots/"+b.ID+"/commands", admin, map[string]string{"trigger": "echo", "url": rv.URL}, nil); res.StatusCode != http.StatusCreated {
		t.Fatalf("create command = %d", res.StatusCode)
	}
	rv.set(http.StatusOK, `{"response_type": "in_channel", "text": "_bedava_ echo"}`)
	if _, res := s.run(ayse, general, "echo", "bedava echo"); res.StatusCode != http.StatusBadRequest {
		t.Errorf("blocked answer = %d", res.StatusCode)
	}
	rv.set(http.StatusOK, `{"response_type": "in_channel", "text": "merhaba echo"}`)
	if r, res := s.run(ayse, general, "echo", "merhaba echo"); res.StatusCode != http.StatusOK || r.ResponseType != "in_channel" {
		t.Errorf("answer = %d %+v", res.StatusCode, r)
	}
	if n := s.count("SELECT count(*) FROM messages WHERE body LIKE '%bedava%'"); n != 0 {
		t.Errorf("%d blocked answers were posted", n)
	}
}

// The text a bot writes into its message after a button press is held to AutoMod too.
func TestInteractionUpdatesFollowAutomod(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	general := s.general(ayse)
	s.moderate(admin)
	b := s.newBot(admin, "Deploy")
	s.call(http.MethodPost, "/api/channels/"+general+"/members", admin, map[string]string{"user_id": b.UserID}, nil)
	var token struct{ Secret string }
	s.call(http.MethodPost, "/api/bots/"+b.ID+"/tokens", admin, map[string]any{"name": "app", "scopes": []string{"messages:write"}}, &token)
	rv := newReceiver(t)
	s.call(http.MethodPut, "/api/bots/"+b.ID+"/interactions", admin, map[string]string{"url": rv.URL}, nil)
	var card api.Message
	if res := s.call(http.MethodPost, "/api/channels/"+general+"/messages", token.Secret, map[string]any{
		"body": "Release", "nonce": "card-nonce-1",
		"attachments": []map[string]any{{"title": "Release 1.4",
			"actions": []map[string]any{{"id": "approve", "type": "button", "text": "Approve", "value": "1.4"}}}},
	}, &card); res.StatusCode != http.StatusCreated {
		t.Fatalf("card = %d", res.StatusCode)
	}
	rv.set(http.StatusOK, `{"text": "ok", "update": {"text": "bedava release"}}`)
	actions := "/api/channels/" + general + "/messages/" + card.Id.String() + "/actions"
	if res := s.call(http.MethodPost, actions, ayse, map[string]any{"attachment": 0, "action_id": "approve"}, nil); res.StatusCode == http.StatusOK {
		t.Error("a blocked update was taken")
	}
	if n := s.count("SELECT count(*) FROM messages WHERE body LIKE '%bedava%'"); n != 0 {
		t.Errorf("%d blocked updates were stored", n)
	}
}

// Text a workflow webhook's sender puts into a message step is held to the
// rules of a member; what the workflow's admin wrote stays allowed.
func TestWorkflowVariablesFollowPostingRules(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	general := s.general(ayse)
	s.general(admin)
	s.moderate(admin)
	hook := func(text string) string {
		var wf api.Workflow
		if res := s.call(http.MethodPost, "/api/workspaces/"+s.defaultWS+"/workflows", admin, map[string]any{
			"name": "Alerts", "trigger": map[string]any{"kind": "webhook", "channel_id": general},
			"steps": []map[string]any{{"id": "say", "kind": "message", "text": text}},
		}, &wf); res.StatusCode != http.StatusCreated || wf.WebhookUrl == nil {
			t.Fatalf("workflow = %d", res.StatusCode)
		}
		return (*wf.WebhookUrl)[strings.Index(*wf.WebhookUrl, "/api/"):]
	}
	send := func(path, text string) {
		t.Helper()
		body, _ := json.Marshal(map[string]string{"text": text})
		req, _ := http.NewRequest(http.MethodPost, s.srv.URL+path, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		res, err := s.client.Do(req)
		if err != nil || res.StatusCode != http.StatusAccepted {
			t.Fatalf("hook = %v %v", res, err)
		}
		_ = res.Body.Close()
	}
	alerts, announce := hook("Alert: @{{webhook.text}}"), hook("@channel {{webhook.text}}")
	send(alerts, "channel wf")
	send(alerts, "_bedava_ wf")
	send(alerts, "disk full")
	send(announce, "deploy at five")
	s.runWorkflows()

	if n := s.count("SELECT count(*) FROM messages WHERE body LIKE '%wf%'"); n != 0 {
		t.Errorf("%d refused workflow messages were posted", n)
	}
	if n := s.count("SELECT count(*) FROM workflow_runs WHERE status = 'failed' AND error <> ''"); n != 2 {
		t.Errorf("failed runs = %d", n)
	}
	if s.botMessages("disk full") != 1 || s.botMessages("deploy at five") != 1 {
		t.Error("allowed workflow messages were not posted")
	}
	if n := s.count("SELECT count(*) FROM message_mentions WHERE kind = 'channel'"); n == 0 {
		t.Error("the admin's own @channel notified no one")
	}
}

// People of a federated server are guests here, held to the posting rules of
// the shared channel; what the rules refuse is dropped, the rest goes through.
func TestFederatedMessagesFollowPostingRules(t *testing.T) {
	sh := newShared(t)
	acme := newStack(t, sh, options{})
	partner := newStack(t, sh, options{})
	admin := acme.admin()
	ayse := acme.user("sub-ayse", "Ayşe")
	general := acme.general(ayse)
	central := acme.channelID(ayse, "Central")
	partnerWS := partner.newWorkspace(admin, "Partner")
	acme.moderate(admin)

	var inv struct{ Code string }
	acme.call(http.MethodPost, "/api/workspaces/"+acme.defaultWS+"/federation/invites", admin, map[string]any{"name": "Partner Inc"}, &inv)
	if res := partner.call(http.MethodPost, "/api/workspaces/"+partnerWS+"/federation/connections", admin, map[string]any{"code": inv.Code, "name": "Acme"}, nil); res.StatusCode != http.StatusCreated {
		t.Fatalf("connect = %d", res.StatusCode)
	}
	var here federation
	acme.call(http.MethodGet, "/api/workspaces/"+acme.defaultWS+"/federation", admin, nil, &here)
	conn := here.Connections[0].Id.String()
	mirrors := map[string]string{}
	for _, ch := range []string{general, central} {
		if res := acme.call(http.MethodPost, "/api/channels/"+ch+"/shares", admin, map[string]any{"connection_id": conn}, nil); res.StatusCode != http.StatusCreated {
			t.Fatalf("share = %d", res.StatusCode)
		}
	}
	federate(t, acme, partner)
	var there federation
	partner.call(http.MethodGet, "/api/workspaces/"+partnerWS+"/federation", admin, nil, &there)
	for _, o := range there.Offers {
		var mirror api.Channel
		if res := partner.call(http.MethodPost, "/api/federation/offers/"+o.Id.String()+"/accept", admin, nil, &mirror); res.StatusCode != http.StatusCreated {
			t.Fatalf("accept = %d", res.StatusCode)
		}
		mirrors[o.Name] = mirror.Id.String()
	}
	federate(t, acme, partner)
	if len(mirrors) != 2 {
		t.Fatalf("mirrors = %v", mirrors)
	}

	target, _ := acme.send(ayse, general, "react here", "fed-rule-0")
	partner.send(admin, mirrors["General"], "hello one", "fed-rule-1")
	partner.send(admin, mirrors["General"], "@channel fed", "fed-rule-2")
	partner.send(admin, mirrors["General"], "_bedava_ fed", "fed-rule-3")
	partner.send(admin, mirrors["Central"], "central fed", "fed-rule-4")
	partner.send(admin, mirrors["General"], "hello two", "fed-rule-5")
	federate(t, acme, partner)
	if n := acme.count("SELECT count(*) FROM messages WHERE body IN ('hello one', 'hello two') AND channel_id = $1", general); n != 2 {
		t.Errorf("allowed messages here = %d", n)
	}
	if n := acme.count("SELECT count(*) FROM messages WHERE body LIKE '%fed' AND channel_id IN ($1, $2)", general, central); n != 0 {
		t.Errorf("%d refused messages were taken", n)
	}

	// An edit is held to the same rules.
	for _, m := range partner.timeline(admin, mirrors["General"]) {
		if m.Body == "hello one" {
			partner.call(http.MethodPatch, "/api/channels/"+mirrors["General"]+"/messages/"+m.Id.String(), admin, map[string]any{"body": "bedava now"}, nil)
		}
	}
	federate(t, acme, partner)
	if n := acme.count("SELECT count(*) FROM messages WHERE body = 'hello one' AND channel_id = $1", general); n != 1 {
		t.Error("a refused edit was taken")
	}

	// A remote guest timed out here posts and reacts no more.
	var guest string
	if err := acme.pool.QueryRow(context.Background(), "SELECT id FROM users WHERE display_name LIKE '%(Partner Inc)'").Scan(&guest); err != nil {
		t.Fatal(err)
	}
	acme.timeOut(admin, guest, time.Now().Add(time.Hour))
	federate(t, acme, partner)
	partner.send(admin, mirrors["General"], "timed out fed", "fed-rule-6")
	for _, m := range partner.timeline(admin, mirrors["General"]) {
		if m.Body == "react here" {
			partner.call(http.MethodPut, "/api/channels/"+mirrors["General"]+"/messages/"+m.Id.String()+"/reactions/%F0%9F%91%8D", admin, nil, nil)
		}
	}
	federate(t, acme, partner)
	if n := acme.count("SELECT count(*) FROM messages WHERE body = 'timed out fed' AND channel_id = $1", general); n != 0 {
		t.Error("a timed-out remote guest posted")
	}
	if n := acme.count("SELECT count(*) FROM message_reactions WHERE message_id = $1", target.ID); n != 0 {
		t.Error("a timed-out remote guest reacted")
	}
	if n := partner.count("SELECT count(*) FROM federation_deliveries"); n != 0 {
		t.Errorf("deliveries left there = %d", n)
	}
}

// Notices written in a member's name (playbook runs, events) follow their
// posting rules.
func TestNoticesFollowPostingRules(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	general := s.general(ayse)
	s.general(admin)
	s.moderate(admin)
	var pb api.Playbook
	if res := s.call(http.MethodPost, "/api/workspaces/"+s.defaultWS+"/playbooks", admin, map[string]any{"name": "Incident",
		"checklists": []map[string]any{{"title": "Triage", "items": []map[string]any{{"title": "Page on-call"}}}}}, &pb); res.StatusCode != http.StatusCreated {
		t.Fatalf("playbook = %d", res.StatusCode)
	}
	runs := "/api/playbooks/" + pb.Id.String() + "/runs"
	events := "/api/workspaces/" + s.defaultWS + "/events"
	start := time.Now().Add(2 * time.Hour)
	event := func(title string) map[string]any {
		return map[string]any{"title": title, "starts_at": start, "ends_at": start.Add(time.Hour), "channel_id": general}
	}

	for name, want := range map[string]string{"@channel run": "broadcast_not_allowed", "bedava run": "automod_blocked"} {
		if _, code := problemCode(t, s, http.MethodPost, runs, ayse, map[string]any{"channel_id": general, "name": name}); code != want {
			t.Errorf("run %q = %s", name, code)
		}
	}
	if _, code := problemCode(t, s, http.MethodPost, events, ayse, event("bedava event")); code != "automod_blocked" {
		t.Errorf("blocked event = %s", code)
	}
	var run api.Run
	if res := s.call(http.MethodPost, runs, ayse, map[string]any{"channel_id": general, "name": "DB outage"}, &run); res.StatusCode != http.StatusCreated {
		t.Fatalf("run = %d", res.StatusCode)
	}

	s.timeOut(admin, s.userID(ayse), time.Now().Add(time.Hour))
	if _, code := problemCode(t, s, http.MethodPost, runs, ayse, map[string]any{"channel_id": general, "name": "Another"}); code != "timed_out" {
		t.Errorf("run while timed out = %s", code)
	}
	if _, code := problemCode(t, s, http.MethodPost, events, ayse, event("Review")); code != "timed_out" {
		t.Errorf("event while timed out = %s", code)
	}
	if _, code := problemCode(t, s, http.MethodPost, "/api/runs/"+run.Id.String()+"/finish", ayse, nil); code != "timed_out" {
		t.Errorf("finish while timed out = %s", code)
	}
	if n := s.count("SELECT count(*) FROM messages WHERE body LIKE '%bedava%' OR body LIKE '%@channel%' OR body LIKE '%Another%' OR body LIKE '%Review%'"); n != 0 {
		t.Errorf("%d refused notices were posted", n)
	}
}

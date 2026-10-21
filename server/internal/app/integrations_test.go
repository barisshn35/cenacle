// SPDX-License-Identifier: Apache-2.0

package app_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/barisshn35/cenacle/server/internal/integrations/signing"
)

// receiver is a bot's server: it records what it gets and answers as told.
type receiver struct {
	*httptest.Server
	mu     sync.Mutex
	got    []received
	status int
	answer string
}

type received struct {
	header http.Header
	body   []byte
}

func newReceiver(t *testing.T) *receiver {
	rv := &receiver{status: http.StatusOK}
	rv.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		rv.mu.Lock()
		defer rv.mu.Unlock()
		rv.got = append(rv.got, received{r.Header.Clone(), body})
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(rv.status)
		_, _ = io.WriteString(w, rv.answer)
	}))
	t.Cleanup(rv.Close)
	return rv
}

func (rv *receiver) set(status int, answer string) {
	rv.mu.Lock()
	defer rv.mu.Unlock()
	rv.status, rv.answer = status, answer
}

func (rv *receiver) received() []received {
	rv.mu.Lock()
	defer rv.mu.Unlock()
	return append([]received(nil), rv.got...)
}

type commandResult struct {
	ResponseType string  `json:"response_type"`
	Text         string  `json:"text"`
	Message      message `json:"message"`
}

func (s *stack) run(token, channelID, command, text string) (commandResult, *http.Response) {
	s.t.Helper()
	var out commandResult
	res := s.call(http.MethodPost, "/api/channels/"+channelID+"/commands", token,
		map[string]string{"command": command, "text": text, "timezone": "Europe/Istanbul"}, &out)
	return out, res
}

func (s *stack) newBot(admin, name string) bot {
	s.t.Helper()
	var b bot
	if res := s.call(http.MethodPost, "/api/workspaces/"+s.defaultWS+"/bots", admin, map[string]string{"name": name}, &b); res.StatusCode != http.StatusCreated {
		s.t.Fatalf("create bot = %d", res.StatusCode)
	}
	return b
}

func TestBuiltinCommands(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	general := s.general(ayse)

	var list struct {
		Commands []struct {
			Trigger string `json:"trigger"`
			Builtin bool   `json:"builtin"`
		} `json:"commands"`
	}
	s.call(http.MethodGet, "/api/workspaces/"+s.defaultWS+"/commands", ayse, nil, &list)
	if len(list.Commands) < 6 || list.Commands[0].Trigger != "remind" || !list.Commands[0].Builtin {
		t.Errorf("commands = %+v", list.Commands)
	}

	if r, res := s.run(ayse, general, "shrug", "olur"); res.StatusCode != http.StatusOK || r.ResponseType != "in_channel" ||
		r.Message.Body != `olur ¯\\\_(ツ)\_/¯` {
		t.Errorf("/shrug = %d %+v", res.StatusCode, r)
	}
	if r, _ := s.run(ayse, general, "/me", "kahve yapıyor"); r.Message.Body != "_kahve yapıyor_" {
		t.Errorf("/me = %+v", r)
	}
	if r, _ := s.run(ayse, general, "topic", "Yeni konu"); r.ResponseType != "ephemeral" {
		t.Errorf("/topic by a member = %+v", r)
	}
	if r, _ := s.run(admin, general, "topic", "Yeni konu"); r.ResponseType != "none" {
		t.Errorf("/topic by the admin = %+v", r)
	}

	var ops channel
	s.call(http.MethodPost, "/api/channels", admin, map[string]any{"name": "Ops"}, &ops)
	if r, _ := s.run(ayse, general, "join", "#ops"); r.ResponseType != "ephemeral" || s.channelID(ayse, "Ops") != ops.ID {
		t.Errorf("/join = %+v", r)
	}
	if r, _ := s.run(ayse, ops.ID, "leave", ""); r.ResponseType != "none" {
		t.Errorf("/leave = %+v", r)
	}
	if r, _ := s.run(ayse, general, "join", "Yok"); r.ResponseType != "ephemeral" || !strings.Contains(r.Text, "No open public channel") {
		t.Errorf("/join of nothing = %+v", r)
	}
	if status, code := problemCode(t, s, http.MethodPost, "/api/channels/"+general+"/commands", ayse,
		map[string]string{"command": "nope"}); status != http.StatusNotFound || code != "unknown_command" {
		t.Errorf("unknown command = %d %s", status, code)
	}
}

func TestBotCommands(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	general := s.general(ayse)
	b := s.newBot(admin, "Deploy")
	rv := newReceiver(t)
	cmds := "/api/bots/" + b.ID + "/commands"

	for _, bad := range []map[string]string{
		{"trigger": "Deploy!", "url": rv.URL},
		{"trigger": "remind", "url": rv.URL},
		{"trigger": "deploy", "url": "ftp://example.com"},
		{"trigger": "deploy", "url": "https://user:pw@example.com"},
	} {
		if status, _ := problemCode(t, s, http.MethodPost, cmds, admin, bad); status != http.StatusBadRequest {
			t.Errorf("command %v = %d", bad, status)
		}
	}
	var created struct {
		Command struct {
			ID string `json:"id"`
		} `json:"command"`
		Secret string `json:"secret"`
	}
	if res := s.call(http.MethodPost, cmds, admin, map[string]string{"trigger": "deploy", "url": rv.URL, "hint": "env"}, &created); res.StatusCode != http.StatusCreated {
		t.Fatalf("create command = %d", res.StatusCode)
	}
	if status, code := problemCode(t, s, http.MethodPost, cmds, admin, map[string]string{"trigger": "deploy", "url": rv.URL}); status != http.StatusConflict || code != "command_taken" {
		t.Errorf("duplicate = %d %s", status, code)
	}

	// An ephemeral answer, signed request.
	rv.set(http.StatusOK, `{"text": "Hangi ortam?"}`)
	if r, res := s.run(ayse, general, "deploy", ""); res.StatusCode != http.StatusOK || r.ResponseType != "ephemeral" || r.Text != "Hangi ortam?" {
		t.Errorf("ephemeral = %d %+v", res.StatusCode, r)
	}
	got := rv.received()[0]
	if !signing.Verify(created.Secret, got.header.Get(signing.Header), got.body, time.Now(), time.Minute) {
		t.Errorf("signature %q does not verify", got.header.Get(signing.Header))
	}
	var req map[string]string
	_ = json.Unmarshal(got.body, &req)
	if req["command"] != "/deploy" || req["user_name"] != "Ayşe" || req["channel_id"] != general {
		t.Errorf("request = %v", req)
	}

	// An answer in the channel is posted as the bot.
	rv.set(http.StatusOK, `{"response_type": "in_channel", "text": "prod'a çıkıyor"}`)
	if r, _ := s.run(ayse, general, "deploy", "prod"); r.ResponseType != "in_channel" || r.Message.Author.ID != b.UserID {
		t.Errorf("in channel = %+v", r)
	}
	rv.set(http.StatusInternalServerError, ``)
	if status, code := problemCode(t, s, http.MethodPost, "/api/channels/"+general+"/commands", ayse,
		map[string]string{"command": "deploy"}); status != http.StatusBadGateway || code != "command_failed" {
		t.Errorf("failing server = %d %s", status, code)
	}

	// Addresses in private networks stay out of reach.
	var internal struct{ Command struct{ ID string } }
	s.call(http.MethodPost, cmds, admin, map[string]string{"trigger": "internal", "url": "http://10.255.255.1/x"}, &internal)
	if status, _ := problemCode(t, s, http.MethodPost, "/api/channels/"+general+"/commands", ayse,
		map[string]string{"command": "internal"}); status != http.StatusBadGateway {
		t.Errorf("private address = %d", status)
	}

	if res := s.call(http.MethodDelete, cmds+"/"+created.Command.ID, admin, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Errorf("delete = %d", res.StatusCode)
	}
	if status, _ := problemCode(t, s, http.MethodPost, "/api/channels/"+general+"/commands", ayse,
		map[string]string{"command": "deploy"}); status != http.StatusNotFound {
		t.Errorf("deleted command = %d", status)
	}
}

type delivery struct {
	ID         string `json:"id"`
	EventType  string `json:"event_type"`
	Status     string `json:"status"`
	Attempts   int    `json:"attempts"`
	LastStatus *int   `json:"last_status"`
}

func TestSubscriptionsAndDeliveries(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ctx := context.Background()
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	general := s.general(ayse)
	b := s.newBot(admin, "Audit")
	rv := newReceiver(t)
	subs := "/api/bots/" + b.ID + "/subscriptions"

	if status, _ := problemCode(t, s, http.MethodPost, subs, admin, map[string]any{"url": rv.URL, "events": []string{"user.created"}}); status != http.StatusBadRequest {
		t.Errorf("unknown event = %d", status)
	}
	var sub struct {
		Subscription struct {
			ID string `json:"id"`
		} `json:"subscription"`
		Secret string `json:"secret"`
	}
	s.call(http.MethodPost, subs, admin, map[string]any{"url": rv.URL, "events": []string{"message.created", "reaction.added"}}, &sub)
	if !strings.HasPrefix(sub.Secret, "cns_") {
		t.Fatalf("secret = %q", sub.Secret)
	}

	// Only channels the bot is in, and not the bot's own messages.
	s.send(ayse, general, "henüz bot yok", "delivery-1")
	s.call(http.MethodPost, "/api/channels/"+general+"/members", admin, map[string]string{"user_id": b.UserID}, nil)
	m, _ := s.send(ayse, general, "selam bot", "delivery-2")
	s.call(http.MethodPut, "/api/channels/"+general+"/messages/"+m.ID+"/reactions/%F0%9F%91%8D", ayse, nil, nil)
	s.call(http.MethodDelete, "/api/channels/"+general+"/messages/"+m.ID+"/reactions/%F0%9F%91%8D", ayse, nil, nil)
	if n, err := s.bg.DeliverDue(ctx); err != nil || n != 2 {
		t.Fatalf("delivered %d, %v", n, err)
	}
	got := rv.received()
	if len(got) != 2 {
		t.Fatalf("received %d", len(got))
	}
	// Deliveries go out in parallel: find each by its event.
	byEvent := map[string]received{}
	for _, g := range got {
		byEvent[g.header.Get("X-Cenacle-Event")] = g
	}
	created, reacted := byEvent["message.created"], byEvent["reaction.added"]
	var body struct {
		ID   string `json:"id"`
		Type string `json:"type"`
		Data struct {
			Body string `json:"body"`
		} `json:"data"`
	}
	_ = json.Unmarshal(created.body, &body)
	if body.Type != "message.created" || body.Data.Body != "selam bot" || created.header.Get("X-Cenacle-Delivery") != body.ID {
		t.Errorf("delivery = %s %v", created.body, created.header)
	}
	if !signing.Verify(sub.Secret, created.header.Get(signing.Header), created.body, time.Now(), time.Minute) {
		t.Error("delivery signature does not verify")
	}
	if !strings.Contains(string(reacted.body), `"reaction.added"`) {
		t.Errorf("reaction delivery = %s", reacted.body)
	}

	// A failing receiver: the delivery waits for a retry, and can be sent again.
	rv.set(http.StatusServiceUnavailable, "")
	s.send(ayse, general, "tekrar dene", "delivery-3")
	if n, _ := s.bg.DeliverDue(ctx); n != 1 {
		t.Fatalf("tried %d", n)
	}
	if n, _ := s.bg.DeliverDue(ctx); n != 0 {
		t.Errorf("retried at once: %d", n)
	}
	var log struct {
		Deliveries []delivery `json:"deliveries"`
		HasMore    bool       `json:"has_more"`
	}
	s.call(http.MethodGet, subs+"/"+sub.Subscription.ID+"/deliveries", admin, nil, &log)
	failed := log.Deliveries[0]
	if len(log.Deliveries) != 3 || failed.Status != "pending" || failed.Attempts != 1 || failed.LastStatus == nil || *failed.LastStatus != 503 {
		t.Fatalf("log = %+v", log.Deliveries)
	}
	rv.set(http.StatusOK, "")
	if res := s.call(http.MethodPost, "/api/bots/"+b.ID+"/deliveries/"+failed.ID+"/resend", admin, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("resend = %d", res.StatusCode)
	}
	if n, _ := s.bg.DeliverDue(ctx); n != 1 {
		t.Errorf("resent %d", n)
	}
	s.call(http.MethodGet, subs+"/"+sub.Subscription.ID+"/deliveries", admin, nil, &log)
	if log.Deliveries[0].Status != "succeeded" {
		t.Errorf("after resend = %+v", log.Deliveries[0])
	}

	// Another workspace's admin sees nothing of it.
	other := s.user("sub-b", "Bora")
	if status, _ := problemCode(t, s, http.MethodGet, subs, other, nil); status != http.StatusForbidden {
		t.Errorf("member listing = %d", status)
	}
	if res := s.call(http.MethodDelete, subs+"/"+sub.Subscription.ID, admin, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Errorf("delete = %d", res.StatusCode)
	}
	s.send(ayse, general, "artık abonelik yok", "delivery-4")
	if n, _ := s.bg.DeliverDue(ctx); n != 0 {
		t.Errorf("delivered after unsubscribing: %d", n)
	}
}

type scheduled struct {
	ID          string `json:"id"`
	Kind        string `json:"kind"`
	ChannelID   string `json:"channel_id"`
	ChannelName string `json:"channel_name"`
	Body        string `json:"body"`
}

func (s *stack) scheduled(token string) []scheduled {
	s.t.Helper()
	var out struct {
		Scheduled []scheduled `json:"scheduled"`
	}
	s.call(http.MethodGet, "/api/scheduled", token, nil, &out)
	return out.Scheduled
}

// due makes everything scheduled due now.
func (s *stack) due() {
	s.t.Helper()
	if _, err := s.pool.Exec(context.Background(), "UPDATE scheduled_messages SET send_at = now() - interval '1 second' WHERE status = 'pending'"); err != nil {
		s.t.Fatal(err)
	}
}

func TestScheduledMessagesAndReminders(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ctx := context.Background()
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	general := s.general(ayse)
	path := "/api/channels/" + general + "/scheduled"

	for _, at := range []time.Time{time.Now(), time.Now().AddDate(2, 0, 0)} {
		if status, _ := problemCode(t, s, http.MethodPost, path, ayse, map[string]any{"body": "x", "send_at": at}); status != http.StatusBadRequest {
			t.Errorf("send_at %v = %d", at, status)
		}
	}
	if status, _ := problemCode(t, s, http.MethodPost, "/api/channels/"+s.channelID(ayse, "Central")+"/scheduled", ayse,
		map[string]any{"body": "x", "send_at": time.Now().Add(time.Hour)}); status != http.StatusForbidden {
		t.Errorf("scheduling into an announcement channel = %d", status)
	}
	var later, canceled scheduled
	s.call(http.MethodPost, path, ayse, map[string]any{"body": "Günaydın **ekip**", "send_at": time.Now().Add(time.Hour)}, &later)
	s.call(http.MethodPost, path, ayse, map[string]any{"body": "vazgeçtim", "send_at": time.Now().Add(time.Hour)}, &canceled)
	if res := s.call(http.MethodDelete, "/api/scheduled/"+canceled.ID, ayse, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Errorf("cancel = %d", res.StatusCode)
	}
	if res := s.call(http.MethodDelete, "/api/scheduled/"+later.ID, admin, nil, nil); res.StatusCode != http.StatusNotFound {
		t.Errorf("cancelling another's = %d", res.StatusCode)
	}

	// A reminder comes from the Cenacle bot in a direct conversation.
	if r, _ := s.run(ayse, general, "remind", "me in 10 minutes to stand up"); r.ResponseType != "ephemeral" || !strings.Contains(r.Text, "stand up") {
		t.Fatalf("/remind = %+v", r)
	}
	if r, _ := s.run(ayse, general, "remind", "whenever"); !strings.Contains(r.Text, "Usage") {
		t.Errorf("/remind without a time = %+v", r)
	}
	list := s.scheduled(ayse)
	// Soonest first: the reminder (in 10 minutes), then the message (in an hour).
	if len(list) != 2 || list[0].Kind != "reminder" || list[0].Body != "⏰ stand up" || list[1].Kind != "message" {
		t.Fatalf("scheduled = %+v", list)
	}

	s.due()
	if n, err := s.bg.SendDueScheduled(ctx); err != nil || n != 2 {
		t.Fatalf("sent %d, %v", n, err)
	}
	if page := s.page(ayse, general); page[len(page)-1].Body != "Günaydın **ekip**" {
		t.Errorf("general = %+v", page[len(page)-1])
	}
	reminder := s.page(ayse, list[0].ChannelID)
	if len(reminder) != 1 || reminder[0].Author.DisplayName != "Cenacle" || reminder[0].Body != "⏰ stand up" {
		t.Errorf("reminder = %+v", reminder)
	}
	if len(s.scheduled(ayse)) != 0 {
		t.Error("sent messages are still listed")
	}

	// A message whose author can no longer post there fails instead of posting.
	var ops channel
	s.call(http.MethodPost, "/api/channels", admin, map[string]any{"name": "Ops"}, &ops)
	s.call(http.MethodPost, "/api/channels/"+ops.ID+"/members", admin, map[string]string{"user_id": s.userID(ayse)}, nil)
	s.call(http.MethodPost, "/api/channels/"+ops.ID+"/scheduled", ayse, map[string]any{"body": "geç kaldım", "send_at": time.Now().Add(time.Hour)}, nil)
	s.call(http.MethodPost, "/api/channels/"+ops.ID+"/leave", ayse, nil, nil)
	s.due()
	if _, err := s.bg.SendDueScheduled(ctx); err != nil {
		t.Fatal(err)
	}
	var status, reason string
	if err := s.pool.QueryRow(ctx, "SELECT status, error FROM scheduled_messages WHERE body = 'geç kaldım'").Scan(&status, &reason); err != nil || status != "failed" || reason == "" {
		t.Errorf("after leaving = %s %q %v", status, reason, err)
	}
}

func TestTokenRotation(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	b := s.newBot(admin, "CI")
	general := s.general(admin)
	s.call(http.MethodPost, "/api/channels/"+general+"/members", admin, map[string]string{"user_id": b.UserID}, nil)
	var first struct {
		Token struct {
			ID string `json:"id"`
		} `json:"token"`
		Secret string `json:"secret"`
	}
	s.call(http.MethodPost, "/api/bots/"+b.ID+"/tokens", admin, map[string]any{"name": "ci", "scopes": []string{"messages:write"}, "expires_in_days": 30}, &first)

	var second struct {
		Token struct {
			ID        string     `json:"id"`
			Name      string     `json:"name"`
			ExpiresAt *time.Time `json:"expires_at"`
		} `json:"token"`
		Secret string `json:"secret"`
	}
	if res := s.call(http.MethodPost, "/api/bots/"+b.ID+"/tokens/"+first.Token.ID+"/rotate", admin, map[string]int{"overlap_hours": 1}, &second); res.StatusCode != http.StatusCreated {
		t.Fatalf("rotate = %d", res.StatusCode)
	}
	if second.Token.Name != "ci" || second.Token.ExpiresAt == nil || time.Until(*second.Token.ExpiresAt) < 29*24*time.Hour {
		t.Errorf("new token = %+v", second.Token)
	}
	for i, secret := range []string{first.Secret, second.Secret} {
		if _, res := s.send(secret, general, "x", "rotation-"+string(rune('a'+i))); res.StatusCode != http.StatusCreated {
			t.Errorf("token %d during the overlap = %d", i, res.StatusCode)
		}
	}
	var third struct {
		Secret string `json:"secret"`
	}
	s.call(http.MethodPost, "/api/bots/"+b.ID+"/tokens/"+second.Token.ID+"/rotate", admin, map[string]int{"overlap_hours": 0}, &third)
	if _, res := s.send(second.Secret, general, "x", "rotation-c"); res.StatusCode != http.StatusUnauthorized {
		t.Errorf("rotated without overlap = %d", res.StatusCode)
	}
	if _, res := s.send(third.Secret, general, "x", "rotation-d"); res.StatusCode != http.StatusCreated {
		t.Errorf("newest = %d", res.StatusCode)
	}
	if status, _ := problemCode(t, s, http.MethodPost, "/api/bots/"+b.ID+"/tokens/"+second.Token.ID+"/rotate", admin, map[string]int{"overlap_hours": 0}); status != http.StatusNotFound {
		t.Errorf("rotating a revoked token = %d", status)
	}
}

func TestGitLabAndAlertmanagerWebhooks(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	b := s.newBot(admin, "Ops")
	general := s.general(admin)
	var gl, am struct {
		URL string `json:"url"`
	}
	s.call(http.MethodPost, "/api/bots/"+b.ID+"/webhooks", admin, map[string]string{"name": "GitLab", "channel_id": general, "kind": "gitlab"}, &gl)
	s.call(http.MethodPost, "/api/bots/"+b.ID+"/webhooks", admin, map[string]string{"name": "Alarm", "channel_id": general, "kind": "alertmanager"}, &am)
	push := `{"object_kind": "push", "ref": "refs/heads/main", "user_name": "Ayşe",
	  "project": {"path_with_namespace": "acme/api", "web_url": "https://gitlab.example.com/acme/api"},
	  "commits": [{"id": "0123456789abcdef", "message": "Fix login", "url": "https://gitlab.example.com/c/1"}], "total_commits_count": 1}`
	if res := s.raw(http.MethodPost, gl.URL, "", push); res.StatusCode != http.StatusOK {
		t.Fatalf("gitlab = %d", res.StatusCode)
	}
	alert := `{"status": "firing", "commonLabels": {"alertname": "DiskFull", "severity": "critical"},
	  "alerts": [{"status": "firing", "labels": {"alertname": "DiskFull", "instance": "db-1"}, "annotations": {"summary": "Disk %95"}}]}`
	if res := s.raw(http.MethodPost, am.URL, "", alert); res.StatusCode != http.StatusOK {
		t.Fatalf("alertmanager = %d", res.StatusCode)
	}
	page := s.page(admin, general)
	if len(page) < 2 {
		t.Fatalf("page = %+v", page)
	}
	gitlabCard, alertCard := page[len(page)-2].Attachments, page[len(page)-1].Attachments
	if len(gitlabCard) != 1 || !strings.Contains(gitlabCard[0]["title"].(string), "pushed to main") {
		t.Errorf("gitlab card = %v", gitlabCard)
	}
	if len(alertCard) != 1 || !strings.Contains(alertCard[0]["title"].(string), "DiskFull") {
		t.Errorf("alert card = %v", alertCard)
	}
}

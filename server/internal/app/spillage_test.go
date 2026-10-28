// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/barisshn35/cenacle/server/internal/api"
)

func TestSpillage(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	mert := s.user("sub-m", "Mert")
	general := s.general(ayse)
	m, _ := s.send(ayse, general, "parola: hunter2", "spill-nonce-1")
	s.call(http.MethodPut, "/api/channels/"+general+"/messages/"+m.ID+"/reactions/%F0%9F%91%8D", mert, nil, nil)
	s.call(http.MethodPut, "/api/me/saved/"+m.ID, mert, map[string]any{}, nil)
	// A legal hold does not keep spillage.
	s.call(http.MethodPost, "/api/workspaces/"+s.defaultWS+"/legal-holds", admin, map[string]any{
		"name": "Dava", "user_ids": []string{}, "channel_ids": []string{general},
	}, nil)

	report := "/api/channels/" + general + "/messages/" + m.ID + "/spillage"
	var rep api.SpillageReport
	if res := s.call(http.MethodPost, report, mert, map[string]string{"reason": "Bir parola paylaşıldı."}, &rep); res.StatusCode != http.StatusCreated || rep.Status != "open" {
		t.Fatalf("report = %d %+v", res.StatusCode, rep)
	}
	if status, code := problemCode(t, s, http.MethodPost, report, ayse, map[string]string{"reason": "again"}); status != http.StatusConflict || code != "already_reported" {
		t.Errorf("second report = %d %s", status, code)
	}
	queue := "/api/workspaces/" + s.defaultWS + "/spillage"
	if status, _ := problemCode(t, s, http.MethodGet, queue, mert, nil); status != http.StatusForbidden {
		t.Errorf("member reads the queue = %d", status)
	}
	var list struct{ Reports []api.SpillageReport }
	s.call(http.MethodGet, queue+"?status=open", admin, nil, &list)
	if len(list.Reports) != 1 || list.Reports[0].Body == nil || *list.Reports[0].Body != "parola: hunter2" {
		t.Fatalf("queue = %+v", list.Reports)
	}

	// The owners choose a reviewer; then only the reviewer decides.
	if res := s.call(http.MethodPut, "/api/workspaces/"+s.defaultWS+"/spillage-reviewers", admin, map[string]any{"user_ids": []string{s.userID(mert)}}, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("reviewers = %d", res.StatusCode)
	}
	decide := "/api/spillage/" + rep.Id.String() + "/decision"
	if status, _ := problemCode(t, s, http.MethodPost, decide, ayse, map[string]string{"decision": "remove"}); status != http.StatusForbidden {
		t.Errorf("non-reviewer decides = %d", status)
	}
	conn := s.connect(ayse, "")
	read(t, conn) // hello
	var decided api.SpillageReport
	if res := s.call(http.MethodPost, decide, mert, map[string]string{"decision": "remove", "note": "Parola değiştirildi."}, &decided); res.StatusCode != http.StatusOK || decided.Status != "removed" || decided.Body != nil {
		t.Fatalf("decide = %d %+v", res.StatusCode, decided)
	}
	if ev := read(t, conn); ev.Type != "message.deleted" {
		t.Errorf("devices got %s", ev.Type)
	}
	var body string
	var reactions, saved int
	ctx := context.Background()
	_ = s.pool.QueryRow(ctx, `SELECT body FROM messages WHERE id = $1`, m.ID).Scan(&body)
	_ = s.pool.QueryRow(ctx, `SELECT count(*) FROM message_reactions WHERE message_id = $1`, m.ID).Scan(&reactions)
	_ = s.pool.QueryRow(ctx, `SELECT count(*) FROM saved_messages WHERE message_id = $1`, m.ID).Scan(&saved)
	if strings.Contains(body, "hunter2") || reactions != 0 || saved != 0 {
		t.Errorf("left behind: %q, %d reactions, %d saved", body, reactions, saved)
	}

	// The incident report: who, when, who could see it; never the content.
	req, _ := http.NewRequest(http.MethodGet, s.srv.URL+"/api/spillage/"+rep.Id.String()+"/incident", nil)
	req.Header.Set("Authorization", "Bearer "+mert)
	res, err := s.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(res.Body)
	_ = res.Body.Close()
	var incident struct {
		Decision string
		Message  struct{ Sha256 string }
		Exposure struct{ Count int }
		Removed  struct{ Reactions, Saved int }
	}
	_ = json.Unmarshal(raw, &incident)
	if res.StatusCode != http.StatusOK || incident.Decision != "removed" || len(incident.Message.Sha256) != 64 ||
		incident.Exposure.Count < 3 || incident.Removed.Reactions != 1 || incident.Removed.Saved != 1 || strings.Contains(string(raw), "hunter2") {
		t.Errorf("incident = %d %s", res.StatusCode, raw)
	}
	if status, _ := problemCode(t, s, http.MethodPost, decide, mert, map[string]string{"decision": "dismiss"}); status != http.StatusConflict {
		t.Errorf("decide twice = %d", status)
	}
}

// Removal also reaches the copies: forwarded snapshots and saved-message reminders.
func TestSpillageRemovesCopies(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	owner := s.admin()
	a := s.user("sub-a", "Ayşe")
	b := s.user("sub-b", "Barış")
	general := s.general(a)
	s.general(b)
	m, _ := s.send(a, general, "token SPILL-MARKER", "spill-nonce-2")
	dm, _ := s.open(b, s.defaultWS, s.userID(a))
	if res := s.call(http.MethodPost, "/api/channels/"+general+"/messages/"+m.ID+"/forward", b,
		map[string]any{"channel_id": dm.ID, "comment": "fyi"}, nil); res.StatusCode != http.StatusCreated {
		t.Fatalf("forward = %d", res.StatusCode)
	}
	if res := s.call(http.MethodPut, "/api/me/saved/"+m.ID, b,
		map[string]any{"remind_at": time.Now().Add(2 * time.Hour).Truncate(time.Second)}, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("save = %d", res.StatusCode)
	}
	var rep api.SpillageReport
	s.call(http.MethodPost, "/api/channels/"+general+"/messages/"+m.ID+"/spillage", b, map[string]string{"reason": "secret"}, &rep)
	conn := s.connect(a, "")
	read(t, conn) // hello
	if res := s.call(http.MethodPost, "/api/spillage/"+rep.Id.String()+"/decision", owner, map[string]string{"decision": "remove"}, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("decide = %d", res.StatusCode)
	}
	// The devices showing the forwarded copy get it redacted.
	updated := false
	for range 3 {
		if ev := read(t, conn); ev.Type == "message.updated" {
			updated = !strings.Contains(string(ev.Data), "SPILL-MARKER")
			break
		}
	}
	if !updated {
		t.Error("no redacted message.updated for the forwarded copy")
	}
	for _, sc := range s.scheduled(b) {
		if strings.Contains(sc.Body, "SPILL-MARKER") {
			t.Errorf("reminder left: %+v", sc)
		}
	}
	var page api.MessagePage
	s.call(http.MethodGet, "/api/channels/"+dm.ID+"/messages", a, nil, &page)
	for _, x := range page.Messages {
		if x.Forward != nil && strings.Contains(x.Forward.Body, "SPILL-MARKER") {
			t.Errorf("forwarded copy left: %q", x.Forward.Body)
		}
	}
	ctx := context.Background()
	_, _ = s.pool.Exec(ctx, `UPDATE scheduled_messages SET send_at = now() - interval '1 minute' WHERE status = 'pending'`)
	if _, err := s.bg.SendDueScheduled(ctx); err != nil {
		t.Fatal(err)
	}
	var live int
	_ = s.pool.QueryRow(ctx, `SELECT count(*) FROM messages WHERE body LIKE '%SPILL-MARKER%' AND deleted_at IS NULL`).Scan(&live)
	if live != 0 {
		t.Errorf("%d live messages quote the spill", live)
	}
	var incident struct {
		Removed struct{ Reminders, Forwards int }
	}
	_ = s.pool.QueryRow(ctx, `SELECT report FROM spillage_reports WHERE id = $1`, rep.Id.String()).Scan(&incident)
	if incident.Removed.Reminders != 1 || incident.Removed.Forwards != 1 {
		t.Errorf("incident counts = %+v", incident.Removed)
	}
}

// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"bufio"
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

// age moves a message back in time.
// age makes a message days old, as one written then would be: its UUIDv7 id
// carries its time too. It returns the new id.
func (s *stack) age(messageID string, days int) string {
	s.t.Helper()
	var id string
	if err := s.pool.QueryRow(context.Background(),
		`UPDATE messages SET id = uuidv7(-make_interval(days => $2)), created_at = now() - make_interval(days => $2)
		 WHERE id = $1 RETURNING id::text`, messageID, days).Scan(&id); err != nil {
		s.t.Fatal(err)
	}
	return id
}

func (s *stack) purgeExpired() int {
	s.t.Helper()
	n, err := chat.RetentionPurger{Queries: store.New(s.pool)}.Run(context.Background())
	if err != nil {
		s.t.Fatal(err)
	}
	return n
}

func TestRetentionAndLegalHolds(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-ayse", "Ayşe")
	general := s.general(ayse)
	old, _ := s.send(ayse, general, "old news", "ret-nonce-1")
	mine, _ := s.send(admin, general, "my old note", "ret-nonce-2")
	fresh, _ := s.send(ayse, general, "fresh", "ret-nonce-3")
	old.ID = s.age(old.ID, 40)
	mine.ID = s.age(mine.ID, 40)

	// No retention: nothing goes.
	if n := s.purgeExpired(); n != 0 {
		t.Fatalf("purged without retention = %d", n)
	}
	path := "/api/workspaces/" + s.defaultWS + "/compliance"
	if status, _ := problemCode(t, s, http.MethodPut, path, ayse, map[string]any{"retention_days": 30, "default_classification": nil, "classifications": []any{}, "attributes": []any{}}); status != http.StatusForbidden {
		t.Errorf("member sets retention = %d", status)
	}
	if res := s.call(http.MethodPut, path, admin, map[string]any{"retention_days": 30, "default_classification": nil, "classifications": []any{}, "attributes": []any{}}, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("set retention = %d", res.StatusCode)
	}

	// A hold on Ayşe keeps her old message; the admin's goes.
	var hold api.LegalHold
	holds := "/api/workspaces/" + s.defaultWS + "/legal-holds"
	if res := s.call(http.MethodPost, holds, admin, map[string]any{"name": "Case 12", "user_ids": []string{s.userID(ayse)}, "channel_ids": []string{}}, &hold); res.StatusCode != http.StatusCreated {
		t.Fatalf("place hold = %d", res.StatusCode)
	}
	if hold.MessageCount != 2 {
		t.Errorf("held messages = %d, want 2", hold.MessageCount)
	}
	if status, _ := problemCode(t, s, http.MethodGet, holds, ayse, nil); status != http.StatusForbidden {
		t.Errorf("member lists holds = %d", status)
	}
	if n := s.purgeExpired(); n != 1 {
		t.Fatalf("purged with a hold = %d, want 1", n)
	}
	gone := s.count(`SELECT count(*) FROM messages WHERE id = $1`, mine.ID)
	kept := s.count(`SELECT count(*) FROM messages WHERE id IN ($1, $2)`, old.ID, fresh.ID)
	if gone != 0 || kept != 2 {
		t.Errorf("after purge: admin's = %d, Ayşe's = %d", gone, kept)
	}

	// Deleting a held message hides it from people but keeps it.
	if res := s.call(http.MethodDelete, "/api/channels/"+general+"/messages/"+old.ID, ayse, nil, nil); res.StatusCode != http.StatusNoContent && res.StatusCode != http.StatusOK {
		t.Fatalf("delete = %d", res.StatusCode)
	}
	if _, err := s.pool.Exec(context.Background(), `UPDATE messages SET deleted_at = now() - interval '30 days' WHERE id = $1`, old.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := (chat.Purger{Queries: store.New(s.pool)}).PurgeDeleted(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := s.count(`SELECT count(*) FROM messages WHERE id = $1`, old.ID); n != 1 {
		t.Errorf("held deleted message purged")
	}

	// eDiscovery sees it, deleted and held; only owners export.
	exportPath := "/api/workspaces/" + s.defaultWS + "/export?q=news"
	if status, _ := problemCode(t, s, http.MethodGet, exportPath, ayse, nil); status != http.StatusForbidden {
		t.Errorf("member exports = %d", status)
	}
	req, _ := http.NewRequest(http.MethodGet, s.srv.URL+exportPath, nil)
	req.Header.Set("Authorization", "Bearer "+admin)
	res, err := s.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK || !strings.HasPrefix(res.Header.Get("Content-Type"), "application/x-ndjson") {
		t.Fatalf("export = %d %s", res.StatusCode, res.Header.Get("Content-Type"))
	}
	var lines []map[string]any
	sc := bufio.NewScanner(res.Body)
	for sc.Scan() {
		var line map[string]any
		if err := json.Unmarshal(sc.Bytes(), &line); err != nil {
			t.Fatal(err)
		}
		lines = append(lines, line)
	}
	if len(lines) != 1 || lines[0]["body"] != "old news" || lines[0]["deleted_at"] == nil || lines[0]["held"] != true {
		t.Errorf("export = %v", lines)
	}
	if n := s.count(`SELECT count(*) FROM audit_events WHERE action = 'messages.exported'`); n != 1 {
		t.Errorf("exports audited = %d", n)
	}

	// Released: retention applies again.
	s.call(http.MethodPost, "/api/legal-holds/"+hold.Id.String()+"/release", admin, nil, &hold)
	if hold.ReleasedAt == nil {
		t.Fatal("not released")
	}
	if n := s.purgeExpired(); n != 1 {
		t.Errorf("purged after release = %d, want 1", n)
	}
}

func TestClassificationsAndAccessRules(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-ayse", "Ayşe")
	mert := s.user("sub-mert", "Mert")
	s.general(ayse)
	s.general(mert)
	path := "/api/workspaces/" + s.defaultWS + "/compliance"
	settings := map[string]any{
		"retention_days":         nil,
		"default_classification": "Internal",
		"classifications": []map[string]any{
			{"name": "Internal", "description": "For employees only", "color": "info"},
			{"name": "Secret", "description": "Named people only", "color": "danger"},
		},
		"attributes": []map[string]any{{"key": "department", "name": "Department"}},
	}
	var got api.Compliance
	if res := s.call(http.MethodPut, path, admin, settings, &got); res.StatusCode != http.StatusOK {
		t.Fatalf("set = %d", res.StatusCode)
	}
	if len(got.Classifications) != 2 || got.DefaultClassification == nil || *got.DefaultClassification != "Internal" {
		t.Fatalf("compliance = %+v", got)
	}
	var classes struct {
		Classifications []api.Classification
		DefaultID       *string `json:"default_id"`
	}
	s.call(http.MethodGet, "/api/workspaces/"+s.defaultWS+"/classifications", ayse, nil, &classes)
	if len(classes.Classifications) != 2 || classes.DefaultID == nil || *classes.DefaultID != got.Classifications[0].Id.String() {
		t.Errorf("classifications for members = %+v", classes)
	}

	var finance channel
	s.call(http.MethodPost, "/api/channels", admin, map[string]any{"name": "Finance"}, &finance)
	s.call(http.MethodPost, "/api/channels/"+finance.ID+"/join", ayse, nil, nil)
	s.call(http.MethodPost, "/api/channels/"+finance.ID+"/join", mert, nil, nil)

	attrs := "/api/workspaces/" + s.defaultWS + "/member-attributes/"
	if status, _ := problemCode(t, s, http.MethodPut, attrs+s.userID(ayse), admin, map[string]string{"floor": "3"}); status != http.StatusBadRequest {
		t.Errorf("unknown attribute = %d", status)
	}
	s.call(http.MethodPut, attrs+s.userID(ayse), admin, map[string]string{"department": "Finance"}, nil)

	// Rules remove who does not meet them (Mert, and the admin).
	var removed api.Removed
	rules := map[string]any{
		"retention_days": 90, "classification_id": got.Classifications[1].Id,
		"access_rules": []map[string]any{{"key": "department", "values": []string{"finance", "Audit"}}},
	}
	if status, _ := problemCode(t, s, http.MethodPut, "/api/channels/"+finance.ID+"/compliance", ayse, rules); status != http.StatusForbidden {
		t.Errorf("member sets rules = %d", status)
	}
	if res := s.call(http.MethodPut, "/api/channels/"+finance.ID+"/compliance", admin, rules, &removed); res.StatusCode != http.StatusOK {
		t.Fatalf("set rules = %d", res.StatusCode)
	}
	if removed.Removed != 2 {
		t.Errorf("removed = %d, want 2 (Mert and the admin)", removed.Removed)
	}
	if status, code := problemCode(t, s, http.MethodPost, "/api/channels/"+finance.ID+"/join", mert, nil); status != http.StatusForbidden || code != chat.CodeAccessRules {
		t.Errorf("Mert joins = %d %s", status, code)
	}
	// The /join command keeps to the same rules.
	s.run(mert, s.general(mert), "join", "Finance")
	for _, m := range s.members(ayse, finance.ID) {
		if m.User.ID == s.userID(mert) {
			t.Error("Mert joined Finance with /join")
		}
	}
	var listed struct{ Channels []api.Channel }
	s.call(http.MethodGet, "/api/channels", ayse, nil, &listed)
	for _, c := range listed.Channels {
		if c.Id.String() == finance.ID && (c.RetentionDays == nil || *c.RetentionDays != 90 || c.ClassificationId == nil || len(*c.AccessRules) != 1) {
			t.Errorf("finance = %+v", c)
		}
	}
	// A new department takes Ayşe out.
	var out api.Removed
	s.call(http.MethodPut, attrs+s.userID(ayse), admin, map[string]string{"department": "Sales"}, &out)
	if out.Removed != 1 {
		t.Errorf("Ayşe removed from = %d", out.Removed)
	}
	// A channel for everyone takes no rules.
	general := s.general(ayse)
	if status, _ := problemCode(t, s, http.MethodPut, "/api/channels/"+general+"/compliance", admin, rules); status != http.StatusBadRequest {
		t.Errorf("rules on General = %d", status)
	}
}

const (
	envelope = "e2e:v1:AAAAAAAAAAAAAAAA:QUJDREVGR0hJSktMTU5PUFFSU1RVVldY"
	keyCheck = "s:AAAAAAAAAAAAAAAAAAAAAA==:" + envelope
)

func TestEncryptedChannels(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	for _, check := range []string{"", envelope} {
		if status, _ := problemCode(t, s, http.MethodPost, "/api/channels", admin, map[string]any{"name": "Vault", "encrypted": true, "key_check": check}); status != http.StatusBadRequest {
			t.Errorf("key check %q = %d", check, status)
		}
	}
	var vault channel
	if res := s.call(http.MethodPost, "/api/channels", admin, map[string]any{"name": "Vault", "encrypted": true, "key_check": keyCheck}, &vault); res.StatusCode != http.StatusCreated {
		t.Fatalf("create = %d", res.StatusCode)
	}
	msgs := "/api/channels/" + vault.ID + "/messages"
	if status, code := problemCode(t, s, http.MethodPost, msgs, admin, map[string]any{"body": "plain text", "nonce": "enc-nonce-1"}); status != http.StatusBadRequest || code != chat.CodeEncrypted {
		t.Errorf("plain text = %d %s", status, code)
	}
	var m api.Message
	if res := s.call(http.MethodPost, msgs, admin, map[string]any{"body": envelope, "nonce": "enc-nonce-2"}, &m); res.StatusCode != http.StatusCreated {
		t.Fatalf("envelope = %d", res.StatusCode)
	}
	if status, code := problemCode(t, s, http.MethodPatch, msgs+"/"+m.Id.String(), admin, map[string]any{"body": "plain"}); status != http.StatusBadRequest || code != chat.CodeEncrypted {
		t.Errorf("edit to plain = %d %s", status, code)
	}
	later := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	if status, code := problemCode(t, s, http.MethodPost, "/api/channels/"+vault.ID+"/scheduled", admin, map[string]any{"body": "plain", "send_at": later}); status != http.StatusBadRequest || code != chat.CodeEncrypted {
		t.Errorf("scheduled plain text = %d %s", status, code)
	}
	if res := s.call(http.MethodPost, "/api/channels/"+vault.ID+"/scheduled", admin, map[string]any{"body": envelope, "send_at": later}, nil); res.StatusCode != http.StatusCreated {
		t.Errorf("scheduled envelope = %d", res.StatusCode)
	}
	// Envelopes stay out of other channels; nothing leaves by forwarding.
	general := s.general(admin)
	if status, code := problemCode(t, s, http.MethodPost, "/api/channels/"+general+"/messages", admin, map[string]any{"body": envelope, "nonce": "enc-nonce-3"}); status != http.StatusBadRequest || code != chat.CodeEncrypted {
		t.Errorf("envelope in General = %d %s", status, code)
	}
	if status, code := problemCode(t, s, http.MethodPost, msgs+"/"+m.Id.String()+"/forward", admin, map[string]any{"channel_id": general}); status != http.StatusBadRequest || code != chat.CodeEncrypted {
		t.Errorf("forward = %d %s", status, code)
	}
	var page struct{ Messages []api.Message }
	s.call(http.MethodGet, "/api/search/messages?q=QUJDREVGR0hJSktMTU5PUFFSU1RVVldY", admin, nil, &page)
	if len(page.Messages) != 0 {
		t.Errorf("search finds envelopes: %d", len(page.Messages))
	}
	var listed struct{ Channels []api.Channel }
	s.call(http.MethodGet, "/api/channels", admin, nil, &listed)
	for _, c := range listed.Channels {
		if c.Id.String() == vault.ID && (c.Encrypted == nil || !*c.Encrypted || c.KeyCheck == nil || *c.KeyCheck != keyCheck) {
			t.Errorf("vault = %+v", c)
		}
	}
}

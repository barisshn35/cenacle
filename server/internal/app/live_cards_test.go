// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"net/http"
	"testing"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
)

func TestChartsAndLiveCards(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	general := s.general(ayse)
	b := s.newBot(admin, "Metrics")
	var created struct {
		Secret string `json:"secret"`
	}
	s.call(http.MethodPost, "/api/bots/"+b.ID+"/tokens", admin, map[string]any{"name": "ci", "scopes": []string{"messages:write"}}, &created)
	s.call(http.MethodPost, "/api/channels/"+general+"/members", admin, map[string]string{"user_id": b.UserID}, nil)
	token := created.Secret

	chart := func(values ...float64) map[string]any {
		return map[string]any{"kind": "bar", "unit": "ms", "labels": []string{"a", "b", "c"},
			"series": []map[string]any{{"name": "api", "values": values}}}
	}
	var m api.Message
	res := s.call(http.MethodPost, "/api/channels/"+general+"/messages", token, map[string]any{
		"body": "", "nonce": "chart-nonce-1", "attachments": []map[string]any{{"chart": chart(120, 1.5e9, 0.25)}},
	}, &m)
	if res.StatusCode != http.StatusCreated || len(m.Attachments) != 1 || m.Attachments[0].Chart == nil ||
		m.Attachments[0].Chart.Series[0].Values[1] != 1.5e9 {
		t.Fatalf("chart message = %d %+v", res.StatusCode, m.Attachments)
	}
	// One value per label, at most 24 labels and 4 series.
	for _, bad := range []map[string]any{
		chart(1, 2),
		{"kind": "pie", "labels": []string{"a"}, "series": []map[string]any{{"name": "x", "values": []float64{1}}}},
	} {
		if status, _ := problemCode(t, s, http.MethodPost, "/api/channels/"+general+"/messages", token, map[string]any{
			"body": "", "nonce": "chart-bad-nonce", "attachments": []map[string]any{{"chart": bad}},
		}); status != http.StatusBadRequest {
			t.Errorf("chart %v = %d", bad, status)
		}
	}

	// The bot replaces its card; members see it; the text is not edited.
	conn := s.connect(ayse, "")
	read(t, conn)
	var changed api.Message
	path := "/api/channels/" + general + "/messages/" + m.Id.String() + "/attachments"
	res = s.call(http.MethodPut, path, token, map[string]any{"attachments": []map[string]any{{"title": "Build 42", "text": "Done", "chart": chart(1, 2, 3)}}}, &changed)
	if res.StatusCode != http.StatusOK || changed.EditedAt != nil || *changed.Attachments[0].Title != "Build 42" {
		t.Fatalf("replace = %d %+v", res.StatusCode, changed)
	}
	if ev := read(t, conn); ev.Type != "message.updated" {
		t.Errorf("event = %s", ev.Type)
	}
	// Nobody else changes them; a message without text keeps a card.
	if status, _ := problemCode(t, s, http.MethodPut, path, ayse, map[string]any{"attachments": []map[string]any{{"title": "x"}}}); status != http.StatusForbidden {
		t.Errorf("someone else = %d", status)
	}
	if status, _ := problemCode(t, s, http.MethodPut, path, token, map[string]any{"attachments": []map[string]any{}}); status != http.StatusBadRequest {
		t.Errorf("no cards left = %d", status)
	}
}

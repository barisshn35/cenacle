// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"net/http"
	"net/url"
	"strings"
	"testing"
)

type richMessage struct {
	message
	Mentions []struct {
		ID          string `json:"id"`
		DisplayName string `json:"display_name"`
	} `json:"mentions"`
	Reactions []struct {
		Emoji string `json:"emoji"`
		Count int    `json:"count"`
		Me    bool   `json:"me"`
	} `json:"reactions"`
	Attachments []map[string]any `json:"attachments"`
}

func (s *stack) page(token, channelID string) []richMessage {
	s.t.Helper()
	var p struct{ Messages []richMessage }
	s.call(http.MethodGet, "/api/channels/"+channelID+"/messages", token, nil, &p)
	return p.Messages
}

func TestReactions(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ayse := s.user("sub-a", "Ayşe")
	mert := s.user("sub-m", "Mert")
	general := s.general(ayse)
	m, _ := s.send(ayse, general, "tepki verin", "react-nonce-1")
	conn := s.connect(ayse, "")
	read(t, conn)

	path := func(emoji string) string {
		return "/api/channels/" + general + "/messages/" + m.ID + "/reactions/" + url.PathEscape(emoji)
	}
	for _, tok := range []string{mert, mert, ayse} { // reacting twice changes nothing
		if res := s.call(http.MethodPut, path("👍"), tok, nil, nil); res.StatusCode != http.StatusNoContent {
			t.Fatalf("react = %d", res.StatusCode)
		}
	}
	s.call(http.MethodPut, path("🎉"), mert, nil, nil)
	ev := read(t, conn)
	if ev.Type != "reaction.added" || !strings.Contains(string(ev.Data), `"emoji":"👍"`) {
		t.Fatalf("event = %+v", ev)
	}

	got := s.page(ayse, general)[0].Reactions
	if len(got) != 2 || got[0].Emoji != "👍" || got[0].Count != 2 || !got[0].Me || got[1].Emoji != "🎉" || got[1].Me {
		t.Errorf("reactions for Ayşe = %+v", got)
	}
	s.call(http.MethodDelete, path("👍"), ayse, nil, nil)
	if got := s.page(mert, general)[0].Reactions; got[0].Count != 1 || !got[0].Me {
		t.Errorf("after taking back = %+v", got)
	}

	for name, emoji := range map[string]string{"text": "ok", "two words": "👍 👍x", "digit": "1"} {
		if status, _ := problemCode(t, s, http.MethodPut, path(emoji), ayse, nil); status != http.StatusBadRequest {
			t.Errorf("%s: %d, want 400", name, status)
		}
	}
	for _, emoji := range []string{"❤️", "👩🏽‍💻", "🇹🇷", "1️⃣"} {
		if res := s.call(http.MethodPut, path(emoji), ayse, nil, nil); res.StatusCode != http.StatusNoContent {
			t.Errorf("%q = %d", emoji, res.StatusCode)
		}
	}
	// Members of the channel react; others do not see the message.
	if res := s.call(http.MethodPut, path("👍"), s.user("sub-z", "Zeynep"), nil, nil); res.StatusCode != http.StatusNoContent {
		t.Errorf("member of General reacting = %d", res.StatusCode)
	}
}

func TestMentions(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	mert := s.user("sub-m", "Mert")
	general := s.general(ayse)
	mertID, ayseID := s.userID(mert), s.userID(ayse)
	ops := s.newWorkspace(admin, "Operasyon") // Ayşe is not in it
	_ = ops

	body := "<@" + mertID + "> bakar mısın? <@" + mertID + "> <@00000000-0000-7000-8000-000000000000>"
	m, res := s.send(ayse, general, body, "mention-nonce-1")
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("send = %d", res.StatusCode)
	}
	msg := s.page(mert, general)[0]
	if msg.ID != m.ID || len(msg.Mentions) != 1 || msg.Mentions[0].ID != mertID || msg.Mentions[0].DisplayName != "Mert" {
		t.Errorf("mentions = %+v", msg.Mentions)
	}

	var list struct {
		Channels []struct {
			ID           string `json:"id"`
			UnreadCount  int    `json:"unread_count"`
			MentionCount int    `json:"mention_count"`
		}
	}
	s.call(http.MethodGet, "/api/channels", mert, nil, &list)
	for _, c := range list.Channels {
		if c.ID == general && (c.UnreadCount != 1 || c.MentionCount != 1) {
			t.Errorf("Mert's General = %+v", c)
		}
	}
	// Reading clears it; editing the mention away removes it.
	s.call(http.MethodPost, "/api/channels/"+general+"/read", mert, map[string]string{"message_id": m.ID}, nil)
	s.call(http.MethodPatch, "/api/channels/"+general+"/messages/"+m.ID, ayse, map[string]string{"body": "boşver <@" + ayseID + ">"}, nil)
	if got := s.page(mert, general)[0].Mentions; len(got) != 1 || got[0].ID != ayseID {
		t.Errorf("mentions after edit = %+v", got)
	}
}

func TestAttachments(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ayse := s.user("sub-a", "Ayşe")
	general := s.general(ayse)
	card := map[string]any{
		"title": "CEN-42: Giriş sayfası", "title_link": "https://jira.example.com/browse/CEN-42",
		"text": "**Öncelik** yüksek", "color": "warning",
		"fields": []map[string]any{{"title": "Durum", "value": "Açık", "short": true}},
	}
	var m richMessage
	res := s.call(http.MethodPost, "/api/channels/"+general+"/messages", ayse,
		map[string]any{"body": "", "nonce": "attach-nonce-1", "attachments": []any{card}}, &m)
	if res.StatusCode != http.StatusCreated || len(m.Attachments) != 1 || m.Attachments[0]["color"] != "warning" {
		t.Fatalf("send = %d %+v", res.StatusCode, m.Attachments)
	}
	if got := s.page(ayse, general)[0].Attachments; len(got) != 1 || got[0]["title"] != "CEN-42: Giriş sayfası" {
		t.Errorf("stored = %+v", got)
	}
	for name, a := range map[string]map[string]any{
		"script link": {"title": "x", "title_link": "javascript:alert(1)"},
		"empty":       {"footer": "only a footer"},
		"color":       {"title": "x", "color": "red"},
		"long title":  {"title": strings.Repeat("x", 201)},
	} {
		res := s.call(http.MethodPost, "/api/channels/"+general+"/messages", ayse,
			map[string]any{"body": "x", "nonce": "attach-bad-" + strings.ReplaceAll(name, " ", "-"), "attachments": []any{a}}, nil)
		if res.StatusCode != http.StatusBadRequest {
			t.Errorf("%s: %d, want 400", name, res.StatusCode)
		}
	}
	if res := s.call(http.MethodPost, "/api/channels/"+general+"/messages", ayse,
		map[string]any{"body": "  ", "nonce": "attach-none-1"}, nil); res.StatusCode != http.StatusBadRequest {
		t.Errorf("empty body without attachments = %d", res.StatusCode)
	}
}

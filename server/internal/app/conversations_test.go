// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/coder/websocket"
)

type conversation struct {
	channel
	Visibility   string `json:"visibility"`
	CanManage    bool   `json:"can_manage"`
	UnreadCount  int    `json:"unread_count"`
	LastReadID   string `json:"last_read_id"`
	Participants []struct {
		ID          string `json:"id"`
		DisplayName string `json:"display_name"`
	} `json:"participants"`
}

func (s *stack) open(token, wsID string, userIDs ...string) (conversation, int) {
	s.t.Helper()
	var c conversation
	res := s.call(http.MethodPost, "/api/workspaces/"+wsID+"/conversations", token, map[string]any{"user_ids": userIDs}, &c)
	return c, res.StatusCode
}

func (s *stack) listed(token, id string) conversation {
	s.t.Helper()
	var out struct{ Channels []conversation }
	s.call(http.MethodGet, "/api/channels", token, nil, &out)
	for _, c := range out.Channels {
		if c.ID == id {
			return c
		}
	}
	s.t.Fatalf("channel %s not listed", id)
	return conversation{}
}

func TestDirectAndGroupConversations(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	mert := s.user("sub-m", "Mert")
	zeynep := s.user("sub-z", "Zeynep")
	ayseID, mertID, zeynepID := s.userID(ayse), s.userID(mert), s.userID(zeynep)

	dm, status := s.open(ayse, s.defaultWS, mertID)
	if status != http.StatusCreated || dm.Kind != "direct" || dm.Visibility != "private" || !dm.CanPost || dm.CanManage ||
		len(dm.Participants) != 1 || dm.Participants[0].DisplayName != "Mert" {
		t.Fatalf("direct conversation = %d %+v", status, dm)
	}
	// The same two people get the same conversation, whoever opens it.
	if again, status := s.open(mert, s.defaultWS, ayseID, mertID); status != http.StatusOK || again.ID != dm.ID ||
		again.Participants[0].DisplayName != "Ayşe" {
		t.Errorf("reopened = %d %+v", status, again)
	}
	group, status := s.open(ayse, s.defaultWS, zeynepID, mertID)
	if status != http.StatusCreated || group.Kind != "group" || len(group.Participants) != 2 {
		t.Fatalf("group = %d %+v", status, group)
	}
	if again, _ := s.open(zeynep, s.defaultWS, mertID, ayseID); again.ID != group.ID {
		t.Errorf("group reopened as %s", again.ID)
	}

	// Validation: nobody else, too many, or outside the workspace.
	if _, status := s.open(ayse, s.defaultWS, ayseID); status != http.StatusBadRequest {
		t.Errorf("conversation with oneself = %d", status)
	}
	ops := s.newWorkspace(admin, "Operasyon")
	if _, status := s.open(admin, ops, ayseID); status != http.StatusBadRequest {
		t.Errorf("conversation with a non-member = %d", status)
	}
	if _, status := s.open(ayse, ops, mertID); status != http.StatusNotFound {
		t.Errorf("conversation in a foreign workspace = %d", status)
	}

	// Only its people see a conversation; workspace owners do not.
	if status, _ := problemCode(t, s, http.MethodGet, "/api/channels/"+dm.ID+"/messages", admin, nil); status != http.StatusNotFound {
		t.Errorf("owner reading a direct conversation = %d", status)
	}
	if status, _ := problemCode(t, s, http.MethodGet, "/api/channels/"+dm.ID+"/messages", zeynep, nil); status != http.StatusNotFound {
		t.Errorf("outsider reading = %d", status)
	}
	for _, c := range s.channels(admin, "/api/channels/directory") {
		if c.ID == dm.ID || c.ID == group.ID {
			t.Errorf("conversation in the directory: %+v", c)
		}
	}
	if status, _ := problemCode(t, s, http.MethodPatch, "/api/channels/"+dm.ID, ayse, map[string]string{"name": "x"}); status != http.StatusForbidden {
		t.Errorf("renaming a conversation = %d", status)
	}
	// Channel names cannot imitate conversation keys.
	if status, _ := problemCode(t, s, http.MethodPost, "/api/channels", admin, map[string]any{"name": "direct:" + ayseID + ":" + mertID}); status != http.StatusBadRequest {
		t.Errorf("channel named like a conversation = %d", status)
	}
}

func TestUnreadCounts(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ayse := s.user("sub-a", "Ayşe")
	mert := s.user("sub-m", "Mert")
	dm, _ := s.open(ayse, s.defaultWS, s.userID(mert))

	var last message
	for i := range 3 {
		last, _ = s.send(ayse, dm.ID, "selam", "unread-nonce-"+string(rune('a'+i)))
	}
	// Your own messages are read; the others' count.
	if c := s.listed(ayse, dm.ID); c.UnreadCount != 0 || c.LastReadID != last.ID {
		t.Errorf("sender's view = %+v", c)
	}
	if c := s.listed(mert, dm.ID); c.UnreadCount != 3 || c.LastReadID != "" {
		t.Errorf("receiver's view = %+v", c)
	}

	// Mert's other device learns of the read position.
	conn := s.connect(mert, "")
	read(t, conn) // hello
	if res := s.call(http.MethodPost, "/api/channels/"+dm.ID+"/read", mert, map[string]string{"message_id": last.ID}, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("mark read = %d", res.StatusCode)
	}
	ev := read(t, conn)
	var data struct {
		ChannelID string `json:"channel_id"`
		MessageID string `json:"message_id"`
	}
	_ = json.Unmarshal(ev.Data, &data)
	if ev.Type != "channel.read" || data.ChannelID != dm.ID || data.MessageID != last.ID {
		t.Errorf("event = %+v", ev)
	}
	if c := s.listed(mert, dm.ID); c.UnreadCount != 0 {
		t.Errorf("after reading: %+v", c)
	}
	// The position never moves back.
	first := s.listed(ayse, dm.ID).LastReadID
	s.call(http.MethodPost, "/api/channels/"+dm.ID+"/read", mert, map[string]string{"message_id": "00000000-0000-7000-8000-000000000000"}, nil)
	if c := s.listed(mert, dm.ID); c.LastReadID != first {
		t.Errorf("moved back to %s", c.LastReadID)
	}
	if status, _ := problemCode(t, s, http.MethodPost, "/api/channels/"+dm.ID+"/read", s.user("sub-z", "Zeynep"), map[string]string{"message_id": last.ID}); status != http.StatusNotFound {
		t.Errorf("outsider marking read = %d", status)
	}

	// What was sent before someone joined is history, not unread.
	general := s.general(ayse)
	s.send(ayse, general, "önce", "history-nonce-1")
	later := s.user("sub-l", "Levent")
	if c := s.listed(later, general); c.UnreadCount != 0 {
		t.Errorf("history counted as unread: %+v", c)
	}
	s.send(ayse, general, "sonra", "history-nonce-2")
	if c := s.listed(later, general); c.UnreadCount != 1 {
		t.Errorf("new message not counted: %+v", c)
	}
}

type presence struct {
	UserID string `json:"user_id"`
	Status string `json:"status"`
}

// readPresence returns the next presence change of a user.
func readPresence(t *testing.T, c *websocket.Conn, userID string) presence {
	t.Helper()
	for {
		var p presence
		_ = json.Unmarshal(readEphemeral(t, c, "presence.changed").Data, &p)
		if p.UserID == userID {
			return p
		}
	}
}

func TestTypingAndPresence(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ayse := s.user("sub-a", "Ayşe")
	mert := s.user("sub-m", "Mert")
	general := s.general(ayse)

	ayseConn := s.connect(ayse, "")
	read(t, ayseConn)

	// Mert comes online: Ayşe, in the same workspace, sees it.
	mertConn := s.connect(mert, "")
	read(t, mertConn)
	mertID := s.userID(mert)
	if p := readPresence(t, ayseConn, mertID); p.Status != "online" {
		t.Errorf("presence = %+v", p)
	}
	var list struct {
		Presence []struct {
			UserID string `json:"user_id"`
			Status string `json:"status"`
		} `json:"presence"`
	}
	s.call(http.MethodGet, "/api/workspaces/"+s.defaultWS+"/presence", ayse, nil, &list)
	if len(list.Presence) != 2 {
		t.Errorf("presence list = %+v", list)
	}

	// Typing reaches the others in the channel, not the typist.
	if res := s.call(http.MethodPost, "/api/channels/"+general+"/typing", mert, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("typing = %d", res.StatusCode)
	}
	var typing struct {
		ChannelID   string `json:"channel_id"`
		DisplayName string `json:"display_name"`
	}
	_ = json.Unmarshal(readEphemeral(t, ayseConn, "typing").Data, &typing)
	if typing.ChannelID != general || typing.DisplayName != "Mert" {
		t.Errorf("typing = %+v", typing)
	}

	// A chosen status reaches others; leaving takes Mert offline.
	if res := s.call(http.MethodPut, "/api/presence", mert, map[string]string{"status": "dnd"}, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("set status = %d", res.StatusCode)
	}
	if p := readPresence(t, ayseConn, mertID); p.Status != "dnd" {
		t.Errorf("status = %+v", p)
	}
	if status, _ := problemCode(t, s, http.MethodPut, "/api/presence", mert, map[string]string{"status": "offline"}); status != http.StatusBadRequest {
		t.Errorf("setting offline = %d", status)
	}
	_ = mertConn.CloseNow()
	if p := readPresence(t, ayseConn, mertID); p.Status != "offline" {
		t.Errorf("after leaving = %+v", p)
	}
}

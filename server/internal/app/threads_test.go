// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
)

func (s *stack) reply(token, channelID, rootID, body, nonce string, also bool) (api.Message, *http.Response) {
	s.t.Helper()
	var m api.Message
	res := s.call(http.MethodPost, "/api/channels/"+channelID+"/messages", token,
		map[string]any{"body": body, "nonce": nonce, "root_id": rootID, "also_in_channel": also}, &m)
	return m, res
}

func (s *stack) timeline(token, channelID string) []api.Message {
	s.t.Helper()
	var page api.MessagePage
	s.call(http.MethodGet, "/api/channels/"+channelID+"/messages", token, nil, &page)
	return page.Messages
}

type threadList struct {
	Threads []api.FollowedThread `json:"threads"`
	HasMore bool                 `json:"has_more"`
}

func (s *stack) threads(token string) threadList {
	s.t.Helper()
	var out threadList
	s.call(http.MethodGet, "/api/me/threads", token, nil, &out)
	return out
}

func TestThreads(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ayse := s.user("sub-ayse", "Ayşe")
	mert := s.user("sub-mert", "Mert")
	zeynep := s.user("sub-zeynep", "Zeynep")
	general := s.general(ayse)
	s.general(mert)
	s.general(zeynep)
	root, _ := s.send(ayse, general, "Release plan?", "nonce-root-1")

	// Mert replies; the reply stays in the thread, not in the channel.
	r1, res := s.reply(mert, general, root.ID, "Friday works", "nonce-reply-1", false)
	if res.StatusCode != http.StatusCreated || r1.RootId == nil || r1.RootId.String() != root.ID {
		t.Fatalf("reply = %d %+v", res.StatusCode, r1)
	}
	for _, m := range s.timeline(zeynep, general) {
		if m.Id == r1.Id {
			t.Error("a thread reply shows in the channel")
		}
		if m.Id.String() == root.ID && (m.Thread == nil || m.Thread.ReplyCount != 1 || m.Thread.Participants[0].DisplayName != "Mert") {
			t.Errorf("root thread = %+v", m.Thread)
		}
	}
	// Replies don't count as unread in the channel.
	if c := s.listed(zeynep, general); c.UnreadCount != 1 {
		t.Errorf("zeynep unread = %d, want 1 (the root)", c.UnreadCount)
	}
	// A reply to a reply goes to the root; also sent to the channel it shows there.
	r2, _ := s.reply(zeynep, general, r1.Id.String(), "Also in channel <@"+s.userID(ayse)+">", "nonce-reply-2", true)
	if r2.RootId == nil || r2.RootId.String() != root.ID {
		t.Errorf("reply to a reply root = %v", r2.RootId)
	}
	found := false
	for _, m := range s.timeline(mert, general) {
		found = found || m.Id == r2.Id
	}
	if !found {
		t.Error("a reply sent to the channel does not show there")
	}
	var replies api.MessagePage
	s.call(http.MethodGet, "/api/channels/"+general+"/messages/"+root.ID+"/replies", ayse, nil, &replies)
	if len(replies.Messages) != 2 || replies.Messages[0].Id != r1.Id {
		t.Errorf("replies = %+v", replies.Messages)
	}
	// also_in_channel needs a root; the root must be in the channel.
	if res := s.call(http.MethodPost, "/api/channels/"+general+"/messages", ayse,
		map[string]any{"body": "x", "nonce": "nonce-bad-1", "also_in_channel": true}, nil); res.StatusCode != http.StatusBadRequest {
		t.Errorf("also_in_channel without root = %d", res.StatusCode)
	}
	if _, res := s.reply(ayse, s.channelID(ayse, "Central"), root.ID, "x", "nonce-bad-2", false); res.StatusCode != http.StatusBadRequest &&
		res.StatusCode != http.StatusForbidden {
		t.Errorf("reply across channels = %d", res.StatusCode)
	}

	// Ayşe (root author) follows: two unread replies, one mentions her.
	list := s.threads(ayse)
	if len(list.Threads) != 1 || list.Threads[0].UnreadCount != 2 || list.Threads[0].MentionCount != 1 {
		t.Fatalf("ayse threads = %+v", list.Threads)
	}
	var counts struct{ Threads, Mentions int }
	s.call(http.MethodGet, "/api/me/threads/unread", ayse, nil, &counts)
	if counts.Threads != 1 || counts.Mentions != 1 {
		t.Errorf("unread counts = %+v", counts)
	}
	if res := s.call(http.MethodPost, "/api/me/threads/"+root.ID+"/read", ayse, map[string]any{"message_id": r2.Id}, nil); res.StatusCode != http.StatusNoContent {
		t.Errorf("mark thread read = %d", res.StatusCode)
	}
	if l := s.threads(ayse); l.Threads[0].UnreadCount != 0 {
		t.Errorf("after reading: %+v", l.Threads[0])
	}
	// Repliers follow; unfollowing hides the thread, following again shows it.
	if l := s.threads(mert); len(l.Threads) != 1 {
		t.Errorf("mert threads = %d", len(l.Threads))
	}
	var state struct {
		Following bool `json:"following"`
	}
	s.call(http.MethodGet, "/api/me/threads/"+root.ID, mert, nil, &state)
	if !state.Following {
		t.Error("a replier does not follow the thread")
	}
	s.call(http.MethodPut, "/api/me/threads/"+root.ID, mert, map[string]any{"following": false}, nil)
	if l := s.threads(mert); len(l.Threads) != 0 {
		t.Errorf("unfollowed threads = %d", len(l.Threads))
	}
	// A new reply does not make him follow again.
	s.reply(ayse, general, root.ID, "OK then", "nonce-reply-3", false)
	if l := s.threads(mert); len(l.Threads) != 0 {
		t.Errorf("unfollowed thread came back: %d", len(l.Threads))
	}
	if res := s.call(http.MethodPut, "/api/me/threads/"+r1.Id.String(), mert, map[string]any{"following": true}, nil); res.StatusCode != http.StatusBadRequest {
		t.Errorf("following a reply = %d", res.StatusCode)
	}

	// Deleting a reply updates the summary.
	s.call(http.MethodDelete, "/api/channels/"+general+"/messages/"+r1.Id.String(), mert, nil, nil)
	var got api.Message
	s.call(http.MethodGet, "/api/channels/"+general+"/messages/"+root.ID, ayse, nil, &got)
	if got.Thread == nil || got.Thread.ReplyCount != 2 {
		t.Errorf("after deleting a reply = %+v", got.Thread)
	}

	// Activity: the mention and the replies for Ayşe.
	var activity struct{ Items []api.ActivityItem }
	s.call(http.MethodGet, "/api/me/activity", ayse, nil, &activity)
	kinds := map[api.ActivityItemKind]int{}
	for _, a := range activity.Items {
		kinds[a.Kind]++
	}
	if kinds[api.ActivityItemKindMention] != 1 {
		t.Errorf("activity = %+v", kinds)
	}
}

func TestPinsSavedAndUnreads(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ayse := s.user("sub-ayse", "Ayşe")
	mert := s.user("sub-mert", "Mert")
	general := s.general(ayse)
	s.general(mert)
	m, _ := s.send(ayse, general, "Read the handbook", "nonce-pin-1")
	path := "/api/channels/" + general + "/messages/" + m.ID

	var pinned api.Message
	if res := s.call(http.MethodPut, path+"/pin", mert, nil, &pinned); res.StatusCode != http.StatusOK || pinned.PinnedAt == nil ||
		pinned.PinnedBy == nil || pinned.PinnedBy.String() != s.userID(mert) {
		t.Fatalf("pin = %d %+v", res.StatusCode, pinned)
	}
	var pins struct{ Messages []api.Message }
	s.call(http.MethodGet, "/api/channels/"+general+"/pins", ayse, nil, &pins)
	if len(pins.Messages) != 1 {
		t.Errorf("pins = %d", len(pins.Messages))
	}
	var unpinned api.Message
	s.call(http.MethodDelete, path+"/pin", ayse, nil, &unpinned)
	if unpinned.PinnedAt != nil || unpinned.Body == "" {
		t.Errorf("unpinned = %+v", unpinned)
	}

	// Saving, with a reminder from the Cenacle bot.
	at := time.Now().Add(2 * time.Hour).Truncate(time.Second)
	var item api.SavedItem
	if res := s.call(http.MethodPut, "/api/me/saved/"+m.ID, mert, map[string]any{"remind_at": at}, &item); res.StatusCode != http.StatusOK ||
		item.RemindAt == nil || item.Channel.Name != "General" {
		t.Fatalf("save = %d %+v", res.StatusCode, item)
	}
	list := s.scheduled(mert)
	if len(list) != 1 || list[0].Kind != "reminder" || !strings.Contains(list[0].Body, "/c/"+general+"?m="+m.ID) {
		t.Fatalf("reminder = %+v", list)
	}
	// Done: the reminder is canceled.
	s.call(http.MethodPut, "/api/me/saved/"+m.ID, mert, map[string]any{"done": true}, &item)
	if item.DoneAt == nil || len(s.scheduled(mert)) != 0 {
		t.Errorf("done = %+v, scheduled %d", item, len(s.scheduled(mert)))
	}
	var saved struct{ Items []api.SavedItem }
	s.call(http.MethodGet, "/api/me/saved", mert, nil, &saved)
	if len(saved.Items) != 1 || saved.Items[0].Message.Body != "Read the handbook" {
		t.Errorf("saved = %+v", saved.Items)
	}
	s.call(http.MethodDelete, "/api/me/saved/"+m.ID, mert, nil, nil)
	s.call(http.MethodGet, "/api/me/saved", mert, nil, &saved)
	if len(saved.Items) != 0 {
		t.Errorf("after removing: %d", len(saved.Items))
	}
	// Messages of channels one is not in cannot be saved.
	var secret channel
	s.call(http.MethodPost, "/api/channels", ayse, map[string]any{"name": "Gizli", "visibility": "private"}, &secret)
	hidden, _ := s.send(ayse, secret.ID, "secret", "nonce-pin-2")
	if res := s.call(http.MethodPut, "/api/me/saved/"+hidden.ID, mert, map[string]any{}, nil); res.StatusCode != http.StatusNotFound {
		t.Errorf("saving a hidden message = %d", res.StatusCode)
	}

	// All unreads: Mert has Ayşe's message unread in General.
	var unreads struct {
		Channels []struct {
			ChannelID string        `json:"channel_id"`
			Messages  []api.Message `json:"messages"`
		}
	}
	s.call(http.MethodGet, "/api/me/unreads?workspace_id="+s.defaultWS, mert, nil, &unreads)
	if len(unreads.Channels) == 0 {
		t.Fatal("no unreads")
	}
	for _, c := range unreads.Channels {
		if c.ChannelID == general && (len(c.Messages) != 1 || c.Messages[0].Body != "Read the handbook") {
			t.Errorf("general unreads = %+v", c.Messages)
		}
	}
}

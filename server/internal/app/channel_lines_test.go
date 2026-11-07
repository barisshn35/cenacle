// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"net/http"
	"testing"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
)

// lines returns the channel lines of a channel's timeline, oldest first.
func (s *stack) lines(token, channelID string) []api.ChannelLine {
	s.t.Helper()
	var page api.MessagePage
	s.call(http.MethodGet, "/api/channels/"+channelID+"/messages", token, nil, &page)
	out := []api.ChannelLine{}
	for _, m := range page.Messages {
		if len(m.Attachments) > 0 && m.Attachments[0].ChannelEvent != nil {
			if m.Body != "" || m.Author.IsBot == nil || !*m.Author.IsBot {
				s.t.Errorf("channel line %+v", m)
			}
			out = append(out, *m.Attachments[0].ChannelEvent)
		}
	}
	return out
}

func TestChannelLines(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	mert := s.user("sub-m", "Mert")
	adminID, ayseID, mertID := s.userID(admin), s.userID(ayse), s.userID(mert)
	var ops channel
	s.call(http.MethodPost, "/api/channels", admin, map[string]any{"name": "Ops"}, &ops)

	s.call(http.MethodPost, "/api/channels/"+ops.ID+"/join", ayse, nil, nil)
	s.call(http.MethodPost, "/api/channels/"+ops.ID+"/members", admin, map[string]any{"user_id": mertID}, nil)
	s.call(http.MethodDelete, "/api/channels/"+ops.ID+"/members/"+mertID, admin, nil, nil)
	s.call(http.MethodPost, "/api/channels/"+ops.ID+"/leave", ayse, nil, nil)

	got := s.lines(admin, ops.ID)
	want := []struct {
		kind  api.ChannelLineKind
		user  string
		actor string
	}{
		{api.ChannelLineKindJoined, ayseID, ""}, {api.ChannelLineKindAdded, mertID, adminID}, {api.ChannelLineKindRemoved, mertID, adminID}, {api.ChannelLineKindLeft, ayseID, ""},
	}
	if len(got) != len(want) {
		t.Fatalf("lines = %+v", got)
	}
	for i, w := range want {
		g := got[i]
		actor := ""
		if g.ActorId != nil {
			actor = g.ActorId.String()
		}
		if g.Kind != w.kind || g.UserId.String() != w.user || actor != w.actor {
			t.Errorf("line %d = %s %s by %q, want %s %s by %q", i, g.Kind, g.UserId, actor, w.kind, w.user, w.actor)
		}
	}

	// Lines never count as unread.
	for _, c := range s.unread(admin) {
		if c.ID == ops.ID && c.UnreadCount != 0 {
			t.Errorf("Ops unread = %d", c.UnreadCount)
		}
	}
}

type unreadChannel struct {
	ID          string `json:"id"`
	UnreadCount int    `json:"unread_count"`
}

func (s *stack) unread(token string) []unreadChannel {
	s.t.Helper()
	var out struct{ Channels []unreadChannel }
	s.call(http.MethodGet, "/api/channels", token, nil, &out)
	return out.Channels
}

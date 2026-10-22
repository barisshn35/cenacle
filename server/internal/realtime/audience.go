// SPDX-License-Identifier: Apache-2.0

package realtime

import (
	"encoding/json"

	"github.com/barisshn35/cenacle/server/internal/events"
)

// audience decides which events one connection receives: messages of the
// channels its user belongs to, changes of those channels and of the user's
// workspaces, and changes of the user's memberships, which it tracks as they
// arrive.
type audience struct {
	user string
	// channel id -> workspace id
	channels   map[string]string
	workspaces map[string]bool
}

type eventData struct {
	Channel struct {
		ID          string `json:"id"`
		WorkspaceID string `json:"workspace_id"`
	} `json:"channel"`
	UserID       string   `json:"user_id"`
	ChannelID    string   `json:"channel_id"`
	WorkspaceID  string   `json:"workspace_id"`
	WorkspaceIDs []string `json:"workspace_ids"`
}

func (a *audience) inChannel(id string) bool {
	_, ok := a.channels[id]
	return ok
}

func (a *audience) allows(ev events.Event) bool {
	var d eventData
	if err := json.Unmarshal(ev.Data, &d); err != nil {
		return false
	}
	switch ev.Type {
	case events.MessageCreated, events.MessageUpdated, events.MessageDeleted,
		events.ReactionAdded, events.ReactionRemoved,
		events.ChannelUpdated, events.ChannelMembersChanged, events.ThreadUpdated,
		events.PollUpdated, events.RunUpdated, events.MessagePreview:
		return a.inChannel(d.ChannelID)
	case events.ChannelCreated: // a channel for everyone in its workspace
		if !a.workspaces[d.Channel.WorkspaceID] {
			return false
		}
		a.channels[d.Channel.ID] = d.Channel.WorkspaceID
		return true
	case events.ChannelJoined:
		if d.UserID != a.user {
			return false
		}
		a.channels[d.Channel.ID] = d.Channel.WorkspaceID
		return true
	case events.ChannelLeft:
		if d.UserID != a.user {
			return false
		}
		delete(a.channels, d.Channel.ID)
		return true
	case events.Typing: // others typing in the user's channels
		return d.UserID != a.user && a.inChannel(d.ChannelID)
	case events.ChannelRead, events.SessionsEnded, // about the user only
		events.ThreadFollowed, events.ThreadRead, events.SavedChanged:
		return d.UserID == a.user
	case events.PresenceChanged, events.UserUpdated:
		if ev.Type == events.UserUpdated && d.UserID == a.user {
			return true
		}
		for _, ws := range d.WorkspaceIDs {
			if a.workspaces[ws] {
				return true
			}
		}
		return false
	case events.BannerChanged, events.TermsChanged: // everyone
		return true
	case events.CategoriesChanged, events.WorkspaceUpdated, events.WorkspaceMembersChanged,
		events.ReportCreated, events.EventChanged, events.EmojiChanged:
		return a.workspaces[d.WorkspaceID]
	case events.WorkspaceJoined:
		if d.UserID != a.user {
			return false
		}
		a.workspaces[d.WorkspaceID] = true
		return true
	case events.WorkspaceLeft:
		if d.UserID != a.user {
			return false
		}
		delete(a.workspaces, d.WorkspaceID)
		for id, ws := range a.channels {
			if ws == d.WorkspaceID {
				delete(a.channels, id)
			}
		}
		return true
	default:
		return false // unknown events stay on the server
	}
}

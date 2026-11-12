// SPDX-License-Identifier: AGPL-3.0-only

package realtime

import (
	"slices"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Cenacle-TR/cenacle/server/internal/events"
)

// audience decides which events one connection receives: messages of the
// channels its user belongs to, changes of those channels and of the user's
// workspaces, and changes of the user's memberships, which it tracks as they
// arrive.
type audience struct {
	user   string
	userID pgtype.UUID
	// channel id -> workspace id
	channels map[string]string
	// joined: channel id -> when the user joined it (Unix ms; absent when the
	// join itself came as an event, which orders it).
	joined     map[string]uint64
	workspaces map[string]bool
	// guestIn: workspaces where the user is a guest; there they hear only of
	// the people in visible[workspace] (policy.VisiblePeople).
	guestIn map[string]bool
	visible map[string]map[string]bool
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
	// To: the only members an event of a channel is for (conversation.read).
	To []string `json:"to"`
}

func (a *audience) inChannel(id string) bool {
	_, ok := a.channels[id]
	return ok
}

// channelEvents go to the members of the channel named by channel_id.
var channelEvents = map[string]bool{
	events.CallRinging: true, events.CallStarted: true, events.CallJoined: true,
	events.CallLeft: true, events.CallEnded: true, events.CallParticipants: true, events.CallReaction: true,
	events.MessageCreated: true, events.MessageUpdated: true, events.MessageDeleted: true,
	events.ReactionAdded: true, events.ReactionRemoved: true,
	events.ChannelUpdated: true, events.ChannelMembersChanged: true, events.ThreadUpdated: true,
	events.PollUpdated: true, events.RunUpdated: true, events.MessagePreview: true,
	events.TabsChanged: true, events.CanvasUpdated: true, events.ListChanged: true, events.MessageAck: true,
	events.ConversationRead: true, events.E2EChanged: true,
}

// beforeJoining reports whether an event of a channel the user is in happened
// (at Unix ms) before they joined it: a resumed connection gets only what it
// would have got live, whatever position it resumes from.
func (a *audience) beforeJoining(typ string, d *eventData, ms uint64) bool {
	if !channelEvents[typ] {
		return false
	}
	joined, ok := a.joined[d.ChannelID]
	return ok && ms < joined
}

// allowsData decides on an event whose data the caller parsed already
// (once for all connections).
func (a *audience) allowsData(typ string, d *eventData) bool {
	if typ == events.ConversationRead {
		// Read receipts go both ways: only to the members who share theirs.
		return a.inChannel(d.ChannelID) && slices.Contains(d.To, a.user)
	}
	if channelEvents[typ] {
		return a.inChannel(d.ChannelID)
	}
	switch typ {
	case events.ChannelCreated:
		// A channel for everyone in its workspace, but not every member is in it
		// (guests and bots are not): the caller reloads the memberships and
		// sends it only to those in it.
		return a.workspaces[d.Channel.WorkspaceID]
	case events.ChannelJoined:
		if d.UserID != a.user {
			return false
		}
		a.channels[d.Channel.ID] = d.Channel.WorkspaceID
		delete(a.joined, d.Channel.ID)
		return true
	case events.ChannelLeft:
		if d.UserID != a.user {
			return false
		}
		delete(a.channels, d.Channel.ID)
		delete(a.joined, d.Channel.ID)
		return true
	case events.Typing: // others typing in the user's channels
		return d.UserID != a.user && a.inChannel(d.ChannelID)
	case events.ChannelRead, events.ChannelUnread, events.SidebarChanged, events.MessageReminder, events.SessionsEnded, // about the user only
		events.ThreadFollowed, events.ThreadRead, events.SavedChanged:
		return d.UserID == a.user
	case events.PresenceChanged, events.UserUpdated:
		if typ == events.UserUpdated && d.UserID == a.user {
			return true
		}
		for _, ws := range d.WorkspaceIDs {
			if a.workspaces[ws] && (!a.guestIn[ws] || a.visible[ws][d.UserID]) {
				return true
			}
		}
		return false
	case events.BannerChanged, events.TermsChanged: // everyone
		return true
	case events.CategoriesChanged, events.WorkspaceUpdated, events.WorkspaceMembersChanged, events.GroupsChanged,
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
				delete(a.joined, id)
			}
		}
		return true
	default:
		return false // unknown events stay on the server
	}
}

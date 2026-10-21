// SPDX-License-Identifier: Apache-2.0

package realtime

import (
	"encoding/json"

	"github.com/barisshn35/cenacle/server/internal/events"
)

// audience decides which events one connection receives: messages of the
// channels its user belongs to, and changes of that user's memberships, which
// it tracks as they arrive.
type audience struct {
	user     string
	channels map[string]bool
}

type channelEventData struct {
	Channel struct {
		ID string `json:"id"`
	} `json:"channel"`
	UserID    string `json:"user_id"`
	ChannelID string `json:"channel_id"`
}

func (a *audience) allows(ev events.Event) bool {
	var d channelEventData
	if err := json.Unmarshal(ev.Data, &d); err != nil {
		return false
	}
	switch ev.Type {
	case events.MessageCreated:
		return a.channels[d.ChannelID]
	case events.ChannelCreated: // default channels: everyone is a member
		a.channels[d.Channel.ID] = true
		return true
	case events.ChannelJoined:
		if d.UserID != a.user {
			return false
		}
		a.channels[d.Channel.ID] = true
		return true
	case events.ChannelLeft:
		if d.UserID != a.user {
			return false
		}
		delete(a.channels, d.Channel.ID)
		return true
	case events.ChannelUpdated, events.ChannelMembersChanged:
		return a.channels[d.ChannelID]
	default:
		return false // unknown events stay on the server
	}
}

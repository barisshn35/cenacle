// SPDX-License-Identifier: AGPL-3.0-only
package chat

import (
	"context"
	"encoding/json"
	"log/slog"

	guuid "github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Cenacle-TR/cenacle/server/internal/events"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

// Kinds of channel lines.
const (
	LineJoined  = "joined"
	LineLeft    = "left"
	LineAdded   = "added"
	LineRemoved = "removed"
)

// channelLine writes a line about a membership change into the channel's
// timeline ("Ada joined", "Can was added by Ada"). Lines are local messages of
// the Cenacle bot: no federation, outgoing webhooks or bot subscriptions, no
// unread count and no notification. Only names are left out: people are given
// by id, so an erased person's line shows no name. Conversations and channels
// whose text the server cannot read get none. A failure is logged, never
// returned: the membership change has happened.
func (h *Handlers) channelLine(ctx context.Context, c store.Channel, kind string, user, actor pgtype.UUID) {
	if isConversation(c) || c.Encrypted || c.Mls {
		return
	}
	ctx = context.WithoutCancel(ctx)
	err := h.inTx(ctx, func(q *store.Queries) error { return writeChannelLine(ctx, q, c, kind, user, actor) })
	if err != nil {
		slog.ErrorContext(ctx, "channel line", "channel", uuid(c.ID).String(), "kind", kind, "err", err)
	}
}

func writeChannelLine(ctx context.Context, q *store.Queries, c store.Channel, kind string, user, actor pgtype.UUID) error {
	bot, err := systemBot(ctx, q, c.WorkspaceID)
	if err != nil {
		return err
	}
	line := map[string]any{"kind": kind, "user_id": uuid(user)}
	if actor.Valid && actor != user {
		line["actor_id"] = uuid(actor)
	}
	raw, err := json.Marshal([]map[string]any{{"channel_event": line}})
	if err != nil {
		return err
	}
	message, err := q.CreateChannelLine(ctx, store.CreateChannelLineParams{
		ChannelID: c.ID, AuthorID: bot.ID, Nonce: "channel-line-" + guuid.NewString(), Attachments: raw,
	})
	if err != nil {
		return err
	}
	payload, err := json.Marshal(messageAPI(message, bot.DisplayName, true))
	if err != nil {
		return err
	}
	return q.InsertOutboxEvent(ctx, store.InsertOutboxEventParams{Type: events.MessageCreated, Data: payload})
}

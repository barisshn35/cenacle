// SPDX-License-Identifier: AGPL-3.0-only
package chat

import (
	"context"
	"encoding/json"

	"github.com/Cenacle-TR/cenacle/server/internal/events"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

// Call outcomes are durable local channel messages. They contain aggregate
// metadata only; the transaction that ends the call inserts them exactly once.
func callSummary(ctx context.Context, q *store.Queries, c store.Call) error {
	channel, err := q.GetChannel(ctx, c.ChannelID)
	if err != nil {
		return err
	}
	bot, err := systemBot(ctx, q, channel.WorkspaceID)
	if err != nil {
		return err
	}
	count, err := q.CountJoinedCallParticipants(ctx, c.ID)
	if err != nil {
		return err
	}
	outcome := "ended"
	switch c.EndReason {
	case "missed", "declined", "busy":
		outcome = c.EndReason
	case "node_lost":
		outcome = "failed"
	}
	duration := int64(0)
	if c.StartedAt.Valid && c.EndedAt.Valid {
		duration = int64(c.EndedAt.Time.Sub(c.StartedAt.Time).Seconds())
		if duration < 0 {
			duration = 0
		}
	} else if outcome == "ended" {
		outcome = "missed"
	}
	notes, err := q.CountCallNotes(ctx, c.ID)
	if err != nil {
		return err
	}
	raw, err := json.Marshal([]map[string]any{{"call_summary": map[string]any{
		"call_id": uuid(c.ID), "outcome": outcome, "duration_seconds": duration, "participants": count,
		"notes": notes,
	}}})
	if err != nil {
		return err
	}
	message, err := q.CreateCallSummaryMessage(ctx, store.CreateCallSummaryMessageParams{
		ChannelID: c.ChannelID, AuthorID: bot.ID, Nonce: "call-summary-" + uuid(c.ID).String(), Attachments: raw,
	})
	if isNoRows(err) {
		return nil
	}
	if err != nil {
		return err
	}
	event := messageAPI(message, bot.DisplayName, true)
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	// Deliberately bypass federation, outgoing webhooks and bot subscriptions.
	return q.InsertOutboxEvent(ctx, store.InsertOutboxEventParams{Type: events.MessageCreated, Data: payload})
}

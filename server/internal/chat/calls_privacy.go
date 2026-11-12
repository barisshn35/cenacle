// SPDX-License-Identifier: AGPL-3.0-only
package chat

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Cenacle-TR/cenacle/server/internal/events"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

func eraseUserCalls(ctx context.Context, q *store.Queries, user pgtype.UUID) error {
	// Lock calls before participants, matching admission/callback lock ordering.
	active, err := q.ListUserOpenCalls(ctx, user)
	if err != nil {
		return err
	}
	for _, candidate := range active {
		call, err := q.LockCall(ctx, candidate.ID)
		if err != nil {
			return err
		}
		if call.EndedAt.Valid {
			continue
		}
		if _, err = q.ForceLeaveCallUser(ctx, store.ForceLeaveCallUserParams{CallID: call.ID, UserID: user}); err != nil {
			return err
		}
		remaining, err := q.CountOpenCallParticipants(ctx, call.ID)
		if err != nil {
			return err
		}
		if remaining == 0 || call.State == "ringing" {
			if _, err = endCall(ctx, q, call, "erased"); err != nil {
				return err
			}
		} else {
			call, err = q.BumpCallRevision(ctx, call.ID)
			if err != nil {
				return err
			}
			if err = emitCall(ctx, q, call, events.CallLeft); err != nil {
				return err
			}
		}
	}
	// Held raw identities stay restricted; public snapshots/export omit redacted
	// rows. Unheld data is removed now and held rows after their hold is released.
	if _, err = q.RedactHeldCallParticipants(ctx, user); err != nil {
		return err
	}
	if _, err = q.EraseCallParticipants(ctx, user); err != nil {
		return err
	}
	// What the person said in call notes is theirs.
	if _, err = q.EraseUserCallNotes(ctx, user); err != nil {
		return err
	}
	_, err = q.EraseCallInitiator(ctx, user)
	return err
}

func (h *Handlers) writeUserCalls(ctx context.Context, put func(string, any) error, user pgtype.UUID) error {
	notes, err := h.Queries.UserCallNotes(ctx, user)
	if err != nil {
		return err
	}
	for _, n := range notes {
		if err := put("call_note", map[string]any{"call_id": uuid(n.CallID), "text": n.Text, "said_at": n.SaidAt}); err != nil {
			return err
		}
	}
	var after pgtype.UUID
	for {
		rows, err := h.Queries.UserCallMetadataAfter(ctx, store.UserCallMetadataAfterParams{UserID: user, After: after, RowLimit: exportPage})
		if err != nil {
			return err
		}
		for _, row := range rows {
			if err = put("call_participation", map[string]any{
				"call_id": uuid(row.CallID), "channel_id": uuid(row.ChannelID), "state": row.State,
				"created_at": row.CreatedAt, "started_at": timeOf(row.StartedAt), "ended_at": timeOf(row.EndedAt),
				"end_reason": row.EndReason, "participant_id": uuid(row.ParticipantID),
				"participant_state": row.ParticipantState, "joined_at": timeOf(row.JoinedAt), "left_at": timeOf(row.LeftAt),
			}); err != nil {
				return err
			}
			after = row.ParticipantID
		}
		if len(rows) < exportPage {
			return nil
		}
	}
}

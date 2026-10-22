// SPDX-License-Identifier: Apache-2.0

// Package profiles holds what the chat and the directory feed share about
// profiles: changing a picture and announcing a change.
package profiles

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/barisshn35/cenacle/server/internal/events"
	"github.com/barisshn35/cenacle/server/internal/preview"
	"github.com/barisshn35/cenacle/server/internal/store"
)

// UserEvent is the data of user.updated.
type UserEvent struct {
	UserID       string   `json:"user_id"`
	WorkspaceIDs []string `json:"workspace_ids"`
}

// Updated records user.updated for the people of the user's workspaces (and
// the user's other devices), in the outbox of q.
func Updated(ctx context.Context, q store.Querier, user pgtype.UUID) error {
	wss, err := q.WorkspacesSharedWith(ctx, user)
	if err != nil {
		return err
	}
	ids := make([]string, len(wss))
	for i, ws := range wss {
		ids[i] = uuid.UUID(ws.Bytes).String()
	}
	raw, err := json.Marshal(UserEvent{UserID: uuid.UUID(user.Bytes).String(), WorkspaceIDs: ids})
	if err != nil {
		return err
	}
	return q.InsertOutboxEvent(ctx, store.InsertOutboxEventParams{Type: events.UserUpdated, Data: raw})
}

// ReplaceAvatar stores a new picture of a person (nil removes it) and deletes
// the previous one. fromDirectory marks a picture the directory gave.
func ReplaceAvatar(ctx context.Context, q store.Querier, user pgtype.UUID, pic *preview.Picture, fromDirectory bool) error {
	var id pgtype.UUID
	if pic != nil {
		var err error
		id, err = q.InsertPicture(ctx, store.InsertPictureParams{ContentType: pic.ContentType, Data: pic.Data, Still: pic.Still})
		if err != nil {
			return err
		}
	}
	old, err := q.SetAvatar(ctx, store.SetAvatarParams{ID: user, AvatarID: id, FromDirectory: fromDirectory && pic != nil})
	if err != nil {
		return err
	}
	if old.Valid {
		return q.DeletePicture(ctx, old)
	}
	return nil
}

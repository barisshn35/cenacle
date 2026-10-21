// SPDX-License-Identifier: Apache-2.0

// Package audit records security-relevant actions: who did what, when, to
// which object (UX plan: every S2/S3 action is audited).
package audit

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/barisshn35/cenacle/server/internal/store"
)

// Actions.
const (
	SessionEnded      = "session.ended"
	SessionsEndedAll  = "sessions.ended_all"
	SessionsEndedByID = "sessions.ended_by_identity_provider"

	WorkspaceCreated       = "workspace.created"
	WorkspaceRenamed       = "workspace.renamed"
	WorkspaceRoleChanged   = "workspace.role_changed"
	WorkspaceMemberRemoved = "workspace.member_removed"
	WorkspaceLeft          = "workspace.left"
	InviteCreated          = "invite.created"
	InviteRevoked          = "invite.revoked"
	InviteAccepted         = "invite.accepted"

	ChannelCreated       = "channel.created"
	ChannelUpdated       = "channel.updated"
	ChannelArchived      = "channel.archived"
	ChannelUnarchived    = "channel.unarchived"
	ChannelMemberAdded   = "channel.member_added"
	ChannelMemberRemoved = "channel.member_removed"
	ChannelRoleChanged   = "channel.role_changed"
	MessageRemoved       = "message.removed_by_manager"

	BotCreated      = "bot.created"
	BotDisabled     = "bot.disabled"
	BotEnabled      = "bot.enabled"
	BotTokenCreated = "bot.token_created" //nolint:gosec // an event name, not a credential
	BotTokenRevoked = "bot.token_revoked" //nolint:gosec // an event name, not a credential
	WebhookCreated  = "bot.webhook_created"
	WebhookDeleted  = "bot.webhook_deleted"
	BotTokenRotated = "bot.token_rotated" //nolint:gosec // an event name, not a credential
	CommandCreated  = "bot.command_created"
	CommandDeleted  = "bot.command_deleted"
	SubscribedTo    = "bot.subscription_created"
	Unsubscribed    = "bot.subscription_deleted"
)

// Event is one entry; Workspace is the zero UUID for account events.
type Event struct {
	Actor      pgtype.UUID
	Workspace  pgtype.UUID
	Action     string
	TargetType string
	TargetID   string
	IP         string
	Detail     map[string]any
}

// Log writes events. A failed write is logged, never returned: the action it
// describes has already happened.
type Log struct {
	Queries interface {
		InsertAuditEvent(ctx context.Context, arg store.InsertAuditEventParams) error
	}
	Logger *slog.Logger
}

// Record writes an event.
func (l *Log) Record(ctx context.Context, e Event) {
	if l == nil {
		return
	}
	detail := []byte("{}")
	if e.Detail != nil {
		if b, err := json.Marshal(e.Detail); err == nil {
			detail = b
		}
	}
	if err := l.Queries.InsertAuditEvent(ctx, store.InsertAuditEventParams{
		ActorID: e.Actor, WorkspaceID: e.Workspace, Action: e.Action,
		TargetType: e.TargetType, TargetID: e.TargetID, IpAddress: e.IP, Detail: detail,
	}); err != nil {
		l.Logger.ErrorContext(ctx, "audit event not recorded", "action", e.Action, "error", err)
	}
}

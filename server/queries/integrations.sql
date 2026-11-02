-- name: CreateSlashCommand :one
INSERT INTO slash_commands (bot_id, workspace_id, trigger, url, description, hint, secret, created_by)
VALUES (@bot_id, @workspace_id, @trigger, @url, @description, @hint, @secret, @created_by)
RETURNING *;

-- name: ListBotCommands :many
SELECT * FROM slash_commands WHERE bot_id = @bot_id ORDER BY trigger;

-- name: ListWorkspaceCommands :many
-- ListWorkspaceCommands returns the custom commands of a workspace whose bot is enabled.
SELECT c.* FROM slash_commands c JOIN bots b ON b.id = c.bot_id
WHERE c.workspace_id = @workspace_id AND b.disabled_at IS NULL
ORDER BY c.trigger;

-- name: GetWorkspaceCommand :one
SELECT sqlc.embed(c), sqlc.embed(u)
FROM slash_commands c JOIN bots b ON b.id = c.bot_id JOIN users u ON u.id = b.user_id
WHERE c.workspace_id = @workspace_id AND c.trigger = @trigger AND b.disabled_at IS NULL;

-- name: DeleteSlashCommand :execrows
DELETE FROM slash_commands WHERE id = @id AND bot_id = @bot_id;

-- name: CreateSubscription :one
INSERT INTO event_subscriptions (bot_id, url, events, secret, created_by)
VALUES (@bot_id, @url, @events, @secret, @created_by)
RETURNING *;

-- name: ListSubscriptions :many
SELECT * FROM event_subscriptions WHERE bot_id = @bot_id ORDER BY created_at DESC;

-- name: DeleteSubscription :execrows
DELETE FROM event_subscriptions WHERE id = @id AND bot_id = @bot_id;

-- name: QueueDeliveries :execrows
-- QueueDeliveries records an event for every enabled subscription of a bot that is a
-- member of the event's channel and wants this event, except the bot's own messages.
-- An event that carries a message's content names it (message_id), so the copy goes
-- when the message does.
INSERT INTO event_deliveries (subscription_id, event_type, payload, message_id)
SELECT s.id, @event_type::text, @payload::jsonb, (SELECT x.id FROM messages x WHERE x.id = sqlc.narg(message_id)::uuid)
FROM event_subscriptions s
JOIN bots b ON b.id = s.bot_id AND b.disabled_at IS NULL
JOIN channel_members m ON m.user_id = b.user_id AND m.channel_id = @channel_id
WHERE s.disabled_at IS NULL AND @event_type::text = ANY(s.events)
  AND (sqlc.narg(actor_id)::uuid IS NULL OR b.user_id <> sqlc.narg(actor_id)::uuid);

-- name: ClaimDueDeliveries :many
-- ClaimDueDeliveries takes due deliveries for one attempt; concurrent workers skip
-- each other's rows. The attempt is counted up front so a crash does not retry forever.
-- What the bot may no longer get (disabled, unsubscribed or out of the channel since
-- the event) fails instead of going out (sendable is false).
UPDATE event_deliveries d SET attempts = d.attempts + 1,
       next_attempt_at = now() + interval '10 minutes',
       status = CASE WHEN due.sendable THEN d.status ELSE 'failed' END,
       last_error = CASE WHEN due.sendable THEN d.last_error
                         ELSE 'The bot is disabled, unsubscribed or no longer in the channel.' END
FROM (
    SELECT ed.id, delivery_sendable(ed.subscription_id, ed.payload) AS sendable FROM event_deliveries ed
    WHERE ed.status = 'pending' AND ed.next_attempt_at <= now()
    ORDER BY ed.next_attempt_at
    LIMIT @row_limit
    FOR UPDATE SKIP LOCKED
) due, event_subscriptions s
WHERE d.id = due.id AND s.id = d.subscription_id
RETURNING d.*, s.url, s.secret, due.sendable;

-- name: FinishDelivery :exec
UPDATE event_deliveries
SET status = @status, last_status = sqlc.narg(last_status), last_error = @last_error,
    next_attempt_at = @next_attempt_at,
    delivered_at = CASE WHEN @status = 'succeeded' THEN now() ELSE delivered_at END
WHERE id = @id;

-- name: ListDeliveries :many
SELECT * FROM event_deliveries
WHERE subscription_id = @subscription_id
  AND (sqlc.narg(before)::uuid IS NULL OR id < sqlc.narg(before)::uuid)
ORDER BY id DESC
LIMIT @row_limit;

-- name: ResendDelivery :one
-- ResendDelivery queues a delivery again if the bot may still get it (sendable);
-- otherwise it stays as it is.
UPDATE event_deliveries d
SET status = CASE WHEN delivery_sendable(d.subscription_id, d.payload) THEN 'pending' ELSE d.status END,
    next_attempt_at = CASE WHEN delivery_sendable(d.subscription_id, d.payload) THEN now() ELSE d.next_attempt_at END,
    attempts = CASE WHEN delivery_sendable(d.subscription_id, d.payload) THEN 0 ELSE d.attempts END,
    last_error = CASE WHEN delivery_sendable(d.subscription_id, d.payload) THEN '' ELSE d.last_error END
FROM event_subscriptions s
WHERE d.id = @id AND s.id = d.subscription_id AND s.bot_id = @bot_id
RETURNING delivery_sendable(d.subscription_id, d.payload)::boolean AS sendable;

-- name: PruneDeliveries :execrows
DELETE FROM event_deliveries WHERE created_at < now() - interval '14 days';

-- name: CreateScheduledMessage :one
INSERT INTO scheduled_messages (kind, channel_id, author_id, owner_id, body, send_at)
VALUES (@kind, @channel_id, @author_id, @owner_id, @body, @send_at)
RETURNING *;

-- name: ListScheduledMessages :many
SELECT sm.*, c.name AS channel_name, c.kind AS channel_kind, c.workspace_id
FROM scheduled_messages sm JOIN channels c ON c.id = sm.channel_id
WHERE sm.owner_id = @owner_id AND sm.status = 'pending'
ORDER BY sm.send_at;

-- name: CountPendingScheduled :one
SELECT count(*) FROM scheduled_messages WHERE owner_id = @owner_id AND status = 'pending';

-- name: CancelScheduledMessage :execrows
UPDATE scheduled_messages SET status = 'canceled'
WHERE id = @id AND owner_id = @owner_id AND status = 'pending';

-- name: CancelScheduledOf :execrows
-- CancelScheduledOf stops what a deactivated person still has queued.
UPDATE scheduled_messages SET status = 'canceled'
WHERE (owner_id = @user_id OR author_id = @user_id) AND status = 'pending';

-- name: ClaimDueScheduled :many
UPDATE scheduled_messages sm SET status = 'sent'
FROM (
    SELECT id FROM scheduled_messages
    WHERE status = 'pending' AND send_at <= now()
    ORDER BY send_at
    LIMIT @row_limit
    FOR UPDATE SKIP LOCKED
) due
WHERE sm.id = due.id
RETURNING sm.*;

-- name: FinishScheduled :exec
UPDATE scheduled_messages SET status = @status, error = @error, message_id = sqlc.narg(message_id)
WHERE id = @id;

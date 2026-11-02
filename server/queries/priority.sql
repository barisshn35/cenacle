-- name: AckMessage :execrows
INSERT INTO message_acks (message_id, user_id) VALUES (@message_id, @user_id)
ON CONFLICT DO NOTHING;

-- name: UnackMessage :execrows
DELETE FROM message_acks WHERE message_id = @message_id AND user_id = @user_id;

-- name: ListAcks :many
-- ListAcks returns who acknowledged messages, in the order they did.
SELECT k.message_id, k.user_id, u.display_name, k.acked_at
FROM message_acks k JOIN users u ON u.id = k.user_id
WHERE k.message_id = ANY(@message_ids::uuid[])
ORDER BY k.message_id, k.acked_at;

-- name: DueReminders :many
-- DueReminders lists the people persistent messages mention (themselves or
-- through a group) who are still in the channel, have not acknowledged them
-- and are due another reminder under their workspace's rules.
SELECT m.id AS message_id, m.channel_id, c.name AS channel_name, c.kind AS channel_kind,
       a.display_name AS author_name,
       -- Burn-on-read text is shown only when revealed.
       (CASE WHEN c.encrypted OR m.burn_seconds IS NOT NULL THEN '' ELSE m.body END)::text AS body,
       mm.user_id
FROM messages m
JOIN channels c ON c.id = m.channel_id
JOIN workspaces w ON w.id = c.workspace_id
JOIN users a ON a.id = m.author_id
JOIN message_mentions mm ON mm.message_id = m.id AND mm.kind IN ('person', 'group')
JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id = mm.user_id
LEFT JOIN message_acks k ON k.message_id = m.id AND k.user_id = mm.user_id
LEFT JOIN message_reminders r ON r.message_id = m.id AND r.user_id = mm.user_id
WHERE m.persistent AND m.deleted_at IS NULL AND w.persistent_notifications
  AND m.created_at > now() - make_interval(mins => w.persistent_every_minutes * (w.persistent_times + 1))
  AND k.user_id IS NULL
  AND coalesce(r.sent, 0) < w.persistent_times
  AND coalesce(r.last_at, m.created_at) <= now() - make_interval(mins => w.persistent_every_minutes)
ORDER BY m.id
LIMIT 500;

-- name: RecordReminder :exec
INSERT INTO message_reminders (message_id, user_id, sent, last_at) VALUES (@message_id, @user_id, 1, now())
ON CONFLICT (message_id, user_id) DO UPDATE SET sent = message_reminders.sent + 1, last_at = now();

-- name: ConversationReads :many
-- ConversationReads returns how far the other members of a conversation who
-- share read receipts have read.
SELECT m.user_id, m.last_read_id
FROM channel_members m JOIN users u ON u.id = m.user_id
WHERE m.channel_id = @channel_id AND m.user_id <> @user_id AND u.share_read_receipts AND NOT u.is_bot;

-- name: ReceiptsAllowed :one
-- ReceiptsAllowed tells whether a person sees and shows read receipts in a
-- channel: a conversation of a workspace that turned them on, and the person
-- shares theirs.
SELECT (w.read_receipts AND c.kind IN ('direct', 'group') AND u.share_read_receipts)::boolean
FROM channels c JOIN workspaces w ON w.id = c.workspace_id, users u
WHERE c.id = @channel_id AND u.id = @user_id;

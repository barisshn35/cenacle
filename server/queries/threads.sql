-- name: ListReplies :many
-- ListReplies returns up to row_limit replies of a thread older than the
-- cursor (all when before is NULL), newest first, with their authors.
SELECT m.*, u.display_name AS author_name, u.is_bot AS author_is_bot
FROM messages m
JOIN users u ON u.id = m.author_id
WHERE m.root_id = @root_id
  AND m.deleted_at IS NULL
  AND (sqlc.narg(before)::uuid IS NULL OR m.id < sqlc.narg(before)::uuid)
ORDER BY m.id DESC
LIMIT @row_limit;

-- name: ThreadSummaries :many
-- ThreadSummaries counts the replies of messages and names their latest three
-- repliers (newest first).
SELECT m.root_id::uuid AS root_id, count(*)::int AS reply_count, max(m.created_at)::timestamptz AS last_reply_at,
       (SELECT coalesce(jsonb_agg(jsonb_build_object('id', p.author_id, 'display_name', u.display_name)
                                  ORDER BY p.last DESC), '[]')
        FROM (SELECT x.author_id, max(x.created_at) AS last FROM messages x
              WHERE x.root_id = m.root_id AND x.deleted_at IS NULL
              GROUP BY x.author_id ORDER BY max(x.created_at) DESC LIMIT 3) p
        JOIN users u ON u.id = p.author_id)::jsonb AS participants
FROM messages m
WHERE m.root_id = ANY(@root_ids::uuid[]) AND m.deleted_at IS NULL
GROUP BY m.root_id;

-- name: FollowThread :exec
-- FollowThread makes people follow a thread unless they chose otherwise before.
INSERT INTO thread_follows (user_id, root_id)
SELECT unnest(@user_ids::uuid[]), @root_id
ON CONFLICT (user_id, root_id) DO NOTHING;

-- name: SetThreadFollowing :exec
-- SetThreadFollowing records a choice to follow (from the latest reply on: older
-- ones count as read) or to stop following a thread.
INSERT INTO thread_follows (user_id, root_id, following, last_read_id)
VALUES (@user_id, @root_id, @following,
        (SELECT x.id FROM messages x WHERE x.root_id = @root_id AND x.deleted_at IS NULL
         ORDER BY x.id DESC LIMIT 1))
ON CONFLICT (user_id, root_id) DO UPDATE SET following = EXCLUDED.following,
    last_read_id = coalesce(thread_follows.last_read_id, EXCLUDED.last_read_id);

-- name: MarkThreadRead :execrows
-- MarkThreadRead moves a follower's read position in a thread forward.
UPDATE thread_follows SET last_read_id = @message_id
WHERE user_id = @user_id AND root_id = @root_id
  AND (last_read_id IS NULL OR last_read_id < @message_id);

-- name: GetThreadFollow :one
SELECT * FROM thread_follows WHERE user_id = @user_id AND root_id = @root_id;

-- name: ListFollowedThreads :many
-- ListFollowedThreads returns the threads a user follows in channels they
-- belong to, the latest reply first, with unread replies and mentions.
SELECT r.id, r.channel_id, r.author_id, r.body, r.nonce, r.created_at, r.edited_at, r.attachments,
       r.pinned_at, r.pinned_by, r.title, r.tags, r.burn_seconds, u.display_name AS author_name, u.is_bot AS author_is_bot,
       c.name AS channel_name, c.kind AS channel_kind, c.workspace_id,
       last.id AS last_reply_id,
       (SELECT count(*) FROM (
            SELECT 1 FROM messages x
            WHERE x.root_id = r.id AND x.deleted_at IS NULL AND x.author_id <> @user_id
              AND (tf.last_read_id IS NULL OR x.id > tf.last_read_id)
            LIMIT 100) s)::int AS unread_count,
       (SELECT count(*) FROM (
            SELECT 1 FROM messages x
            JOIN message_mentions mm ON mm.message_id = x.id AND mm.user_id = @user_id
            WHERE x.root_id = r.id AND x.deleted_at IS NULL
              AND (tf.last_read_id IS NULL OR x.id > tf.last_read_id)
            LIMIT 100) s)::int AS mention_count
FROM thread_follows tf
JOIN messages r ON r.id = tf.root_id AND r.deleted_at IS NULL
JOIN channels c ON c.id = r.channel_id AND c.archived_at IS NULL
JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = @user_id
JOIN users u ON u.id = r.author_id
CROSS JOIN LATERAL (
    SELECT x.id FROM messages x WHERE x.root_id = r.id AND x.deleted_at IS NULL
    ORDER BY x.id DESC LIMIT 1) last
WHERE tf.user_id = @user_id AND tf.following
  AND (sqlc.narg(workspace_id)::uuid IS NULL OR c.workspace_id = sqlc.narg(workspace_id)::uuid)
  AND (sqlc.narg(before)::uuid IS NULL OR last.id < sqlc.narg(before)::uuid)
ORDER BY last.id DESC
LIMIT @row_limit;

-- name: CountUnreadThreads :one
-- CountUnreadThreads counts followed threads with unread replies (up to 100)
-- and those among them that mention the user.
SELECT count(*)::int AS threads, count(*) FILTER (WHERE mentioned)::int AS mentioned
FROM (
    SELECT EXISTS (
               SELECT 1 FROM messages x
               JOIN message_mentions mm ON mm.message_id = x.id AND mm.user_id = @user_id
               WHERE x.root_id = tf.root_id AND x.deleted_at IS NULL
                 AND (tf.last_read_id IS NULL OR x.id > tf.last_read_id)) AS mentioned
    FROM thread_follows tf
    JOIN messages r ON r.id = tf.root_id AND r.deleted_at IS NULL
    JOIN channels c ON c.id = r.channel_id AND c.archived_at IS NULL
    JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = @user_id
    WHERE tf.user_id = @user_id AND tf.following
      AND (sqlc.narg(workspace_id)::uuid IS NULL OR c.workspace_id = sqlc.narg(workspace_id)::uuid)
      AND EXISTS (
          SELECT 1 FROM messages x
          WHERE x.root_id = tf.root_id AND x.deleted_at IS NULL AND x.author_id <> @user_id
            AND (tf.last_read_id IS NULL OR x.id > tf.last_read_id))
    LIMIT 100) t;

-- name: SetPinned :one
UPDATE messages
SET pinned_at = CASE WHEN @pinned::boolean THEN now() END,
    pinned_by = CASE WHEN @pinned::boolean THEN sqlc.narg(pinned_by)::uuid END
WHERE id = @id AND deleted_at IS NULL
RETURNING *;

-- name: CountPins :one
SELECT count(*)::int FROM messages WHERE channel_id = @channel_id AND pinned_at IS NOT NULL AND deleted_at IS NULL;

-- name: ListPins :many
SELECT m.*, u.display_name AS author_name, u.is_bot AS author_is_bot
FROM messages m
JOIN users u ON u.id = m.author_id
WHERE m.channel_id = @channel_id AND m.pinned_at IS NOT NULL AND m.deleted_at IS NULL
ORDER BY m.pinned_at DESC
LIMIT 100;

-- name: GetMessagesByIDs :many
-- GetMessagesByIDs returns messages with their authors and channels.
SELECT m.*, u.display_name AS author_name, u.is_bot AS author_is_bot,
       c.name AS channel_name, c.kind AS channel_kind, c.workspace_id
FROM messages m
JOIN users u ON u.id = m.author_id
JOIN channels c ON c.id = m.channel_id
WHERE m.id = ANY(@ids::uuid[]);

-- name: UpsertSaved :one
INSERT INTO saved_messages (user_id, message_id, remind_at, done_at)
VALUES (@user_id, @message_id, sqlc.narg(remind_at), CASE WHEN @done::boolean THEN now() END)
ON CONFLICT (user_id, message_id) DO UPDATE SET
    remind_at = EXCLUDED.remind_at,
    done_at = CASE WHEN @done::boolean THEN coalesce(saved_messages.done_at, now()) END
RETURNING *;

-- name: GetSaved :one
SELECT * FROM saved_messages WHERE user_id = @user_id AND message_id = @message_id;

-- name: SetSavedReminder :exec
UPDATE saved_messages SET reminder_id = sqlc.narg(reminder_id)
WHERE user_id = @user_id AND message_id = @message_id;

-- name: DeleteSaved :one
DELETE FROM saved_messages WHERE user_id = @user_id AND message_id = @message_id
RETURNING *;

-- name: CountSaved :one
SELECT count(*)::int FROM saved_messages WHERE user_id = @user_id;

-- name: ListSaved :many
-- ListSaved returns the saved messages of a user in channels they belong to,
-- newest first.
SELECT s.message_id, s.created_at AS saved_at, s.remind_at, s.done_at
FROM saved_messages s
JOIN messages m ON m.id = s.message_id AND m.deleted_at IS NULL
JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id = @user_id
WHERE s.user_id = @user_id
ORDER BY s.created_at DESC
LIMIT 500;

-- name: CancelScheduled :exec
UPDATE scheduled_messages SET status = 'canceled' WHERE id = @id AND status = 'pending';

-- name: ListActivity :many
-- ListActivity returns what happened for a user in the last 30 days, newest
-- first: mentions, replies in threads they follow and reactions to their
-- messages, in channels they belong to.
SELECT a.kind, a.message_id, a.actor_id, a.emoji, a.at
FROM (
    SELECT 'mention'::text AS kind, m.id AS message_id, m.channel_id, m.author_id AS actor_id,
           ''::text AS emoji, m.created_at AS at
    FROM message_mentions mm
    JOIN messages m ON m.id = mm.message_id
    WHERE mm.user_id = @user_id AND m.author_id <> @user_id AND m.deleted_at IS NULL
      AND m.created_at > now() - interval '30 days'
    UNION ALL
    SELECT 'reply', m.id, m.channel_id, m.author_id, '', m.created_at
    FROM thread_follows tf
    JOIN messages m ON m.root_id = tf.root_id
    WHERE tf.user_id = @user_id AND tf.following AND m.author_id <> @user_id AND m.deleted_at IS NULL
      AND m.created_at > now() - interval '30 days'
      AND NOT EXISTS (SELECT 1 FROM message_mentions mm WHERE mm.message_id = m.id AND mm.user_id = @user_id)
    UNION ALL
    SELECT 'reaction', m.id, m.channel_id, r.user_id, r.emoji, r.created_at
    FROM messages m
    JOIN message_reactions r ON r.message_id = m.id
    WHERE m.author_id = @user_id AND r.user_id <> @user_id AND m.deleted_at IS NULL
      AND r.created_at > now() - interval '30 days'
) a
JOIN channel_members cm ON cm.channel_id = a.channel_id AND cm.user_id = @user_id
JOIN channels c ON c.id = a.channel_id
WHERE a.at > now() - interval '30 days'
  AND (sqlc.narg(workspace_id)::uuid IS NULL OR c.workspace_id = sqlc.narg(workspace_id)::uuid)
  AND (sqlc.narg(before)::timestamptz IS NULL OR a.at < sqlc.narg(before)::timestamptz)
ORDER BY a.at DESC
LIMIT @row_limit;

-- name: ListUnreadMessages :many
-- ListUnreadMessages returns, for each channel of a workspace with unread
-- messages, its 20 latest unread messages of others.
SELECT x.id, x.channel_id, x.author_id, x.body, x.nonce, x.created_at, x.edited_at, x.attachments,
       x.root_id, x.also_in_channel, x.pinned_at, x.pinned_by, x.title, x.tags,
       x.link_url, x.link_state, x.forward, x.sticker_id, x.burn_seconds, x.task_id, x.submission_id,
       x.priority, x.ack_requested, x.persistent,
       u.display_name AS author_name, u.is_bot AS author_is_bot
FROM channel_members cm
JOIN channels c ON c.id = cm.channel_id AND c.archived_at IS NULL AND c.workspace_id = @workspace_id
CROSS JOIN LATERAL (
    SELECT m.* FROM messages m
    WHERE m.channel_id = c.id AND m.deleted_at IS NULL AND m.author_id <> @user_id
      AND (m.root_id IS NULL OR m.also_in_channel)
      AND (cm.last_read_id IS NULL OR m.id > cm.last_read_id)
    ORDER BY m.id DESC LIMIT 20) x
JOIN users u ON u.id = x.author_id
WHERE cm.user_id = @user_id
ORDER BY x.channel_id, x.id;

-- name: GetUsersByIDs :many
SELECT * FROM users WHERE id = ANY(@ids::uuid[]);

-- name: MarkThreadUnreadFrom :one
-- MarkThreadUnreadFrom moves a follower's read position in a thread back to just
-- before a reply (following the thread if they did not).
INSERT INTO thread_follows (user_id, root_id, last_read_id)
VALUES (@user_id, @root_id, (
    SELECT x.id FROM messages x
    WHERE (x.root_id = @root_id OR x.id = @root_id) AND x.id < @message_id
    ORDER BY x.id DESC LIMIT 1))
ON CONFLICT (user_id, root_id) DO UPDATE
SET following = true, last_read_id = EXCLUDED.last_read_id
RETURNING last_read_id;

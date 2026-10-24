-- name: ListMemberChannels :many
-- ListMemberChannels returns the channels a user belongs to with the user's
-- roles in each and in its workspace: mandatory ones first, then by name.
SELECT sqlc.embed(c), m.role, wm.role AS workspace_role, m.last_read_id,
       -- Unread messages of others, counted up to 100 (clients show "99+").
       (SELECT count(*) FROM (
            SELECT 1 FROM messages x
            WHERE x.channel_id = c.id AND x.deleted_at IS NULL AND x.author_id <> @user_id
              AND (x.root_id IS NULL OR x.also_in_channel)
              AND (m.last_read_id IS NULL OR x.id > m.last_read_id)
            LIMIT 100) unread)::int AS unread_count,
       -- Unread messages that mention the user, also up to 100.
       (SELECT count(*) FROM (
            SELECT 1 FROM message_mentions mm JOIN messages x ON x.id = mm.message_id
            WHERE mm.user_id = @user_id AND x.channel_id = c.id AND x.deleted_at IS NULL
              AND (x.root_id IS NULL OR x.also_in_channel)
              AND (m.last_read_id IS NULL OR x.id > m.last_read_id)
            LIMIT 100) mentioned)::int AS mention_count
FROM channels c
JOIN channel_members m ON m.channel_id = c.id AND m.user_id = @user_id
JOIN workspace_members wm ON wm.workspace_id = c.workspace_id AND wm.user_id = @user_id
WHERE c.archived_at IS NULL
ORDER BY c.is_mandatory DESC, lower(c.name);

-- name: ListAllChannels :many
-- ListAllChannels returns the public channels of a workspace and its private
-- channels the user belongs to, with the user's role ('' when not a member).
SELECT sqlc.embed(c), coalesce(m.role, '')::text AS role,
       (SELECT count(*) FROM channel_members x WHERE x.channel_id = c.id)::int AS member_count
FROM channels c
LEFT JOIN channel_members m ON m.channel_id = c.id AND m.user_id = @user_id
WHERE c.workspace_id = @workspace_id
  AND c.kind IN ('standard', 'announcement')
  AND (c.visibility = 'public' OR m.user_id IS NOT NULL)
ORDER BY c.is_mandatory DESC, lower(c.name);

-- name: ListMemberChannelIDs :many
SELECT m.channel_id, c.workspace_id
FROM channel_members m
JOIN channels c ON c.id = m.channel_id
WHERE m.user_id = @user_id;

-- name: GetChannel :one
SELECT * FROM channels WHERE id = @id;

-- name: GetMemberRole :one
-- GetMemberRole returns the user's role in a channel ('' when not a member).
SELECT coalesce((
    SELECT role FROM channel_members WHERE channel_id = @channel_id AND user_id = @user_id
), '')::text;

-- name: ListMembers :many
SELECT u.id, u.display_name, u.email, u.is_bot, m.role, m.joined_at
FROM channel_members m
JOIN users u ON u.id = m.user_id
WHERE m.channel_id = @channel_id
ORDER BY m.role = 'manager' DESC, lower(u.display_name), u.id;

-- name: UpdateChannel :one
UPDATE channels
SET name = @name, visibility = @visibility, topic = @topic, category_id = sqlc.narg(category_id),
    slow_mode_seconds = @slow_mode_seconds, forum_tags = coalesce(@forum_tags::text[], '{}'),
    moderation = @moderation
WHERE id = @id
RETURNING *;

-- name: SetChannelArchived :one
UPDATE channels
SET archived_at = CASE WHEN @archived::boolean THEN coalesce(archived_at, now()) END
WHERE id = @id
RETURNING *;

-- name: ListCategories :many
SELECT * FROM channel_categories WHERE workspace_id = @workspace_id ORDER BY position, lower(name);

-- name: GetCategory :one
SELECT * FROM channel_categories WHERE id = @id;

-- name: CreateCategory :one
INSERT INTO channel_categories (workspace_id, name, position)
VALUES (@workspace_id, @name,
        coalesce((SELECT max(position) + 1 FROM channel_categories WHERE workspace_id = @workspace_id), 0))
RETURNING *;

-- name: UpdateCategory :one
UPDATE channel_categories SET name = @name, position = @position WHERE id = @id
RETURNING *;

-- name: DeleteCategory :execrows
DELETE FROM channel_categories WHERE id = @id;

-- name: CreateChannel :one
INSERT INTO channels (workspace_id, name, topic, kind, is_default, visibility, created_by, encrypted, key_check)
VALUES (@workspace_id, @name, @topic, @kind, @is_default, @visibility, @created_by, @encrypted, @key_check)
RETURNING *;

-- name: EnsureChannel :one
-- EnsureChannel creates a configured channel or brings an existing one of that
-- name to the configured kind and flags (and public: everyone is a member);
-- the topic of an existing channel is kept.
INSERT INTO channels (workspace_id, name, topic, kind, is_default, is_mandatory)
VALUES (@workspace_id, @name, @topic, @kind, @is_default, @is_mandatory)
ON CONFLICT (workspace_id, (lower(name))) DO UPDATE
SET kind = EXCLUDED.kind, is_default = EXCLUDED.is_default, is_mandatory = EXCLUDED.is_mandatory,
    visibility = 'public'
RETURNING *;

-- name: AddMember :execrows
INSERT INTO channel_members (channel_id, user_id, role) VALUES (@channel_id, @user_id, @role)
ON CONFLICT DO NOTHING;

-- name: RemoveMember :execrows
DELETE FROM channel_members WHERE channel_id = @channel_id AND user_id = @user_id;

-- name: AddAllUsers :execrows
-- AddAllUsers makes every member of the channel's workspace a member of it
-- (guests are added where they work, like bots).
INSERT INTO channel_members (channel_id, user_id)
SELECT c.id, wm.user_id
FROM channels c
JOIN workspace_members wm ON wm.workspace_id = c.workspace_id AND wm.role <> 'guest'
JOIN users u ON u.id = wm.user_id AND NOT u.is_bot -- bots are added where they work
WHERE c.id = @channel_id
ON CONFLICT DO NOTHING;

-- name: JoinDefaultChannels :many
-- JoinDefaultChannels makes a user a member of every default channel of the
-- workspaces they belong to and returns the channels they newly joined.
INSERT INTO channel_members (channel_id, user_id)
SELECT c.id, @user_id
FROM channels c
JOIN workspace_members wm ON wm.workspace_id = c.workspace_id AND wm.user_id = @user_id AND wm.role <> 'guest'
WHERE c.is_default
ON CONFLICT DO NOTHING
RETURNING channel_id;

-- name: SetChannelMemberRole :execrows
UPDATE channel_members SET role = @role WHERE channel_id = @channel_id AND user_id = @user_id;

-- name: CreateMessage :one
-- CreateMessage inserts a message; with a nonce the author used before it
-- returns nothing (see GetMessageByNonce).
INSERT INTO messages (channel_id, author_id, body, nonce, attachments, has_files, root_id, also_in_channel, title, tags,
                      link_url, link_state, forward, sticker_id, burn_seconds, task_id, submission_id,
                      priority, ack_requested, persistent)
VALUES (@channel_id, @author_id, @body, @nonce, @attachments, @has_files, sqlc.narg(root_id), @also_in_channel,
        sqlc.narg(title), coalesce(@tags::text[], '{}'),
        sqlc.narg(link_url), CASE WHEN sqlc.narg(link_url)::text IS NULL THEN NULL ELSE 'pending' END,
        sqlc.narg(forward), sqlc.narg(sticker_id), sqlc.narg(burn_seconds), sqlc.narg(task_id),
        sqlc.narg(submission_id), sqlc.narg(priority), @ack_requested, @persistent)
ON CONFLICT ON CONSTRAINT messages_author_nonce_key DO NOTHING
RETURNING *;

-- name: GetMessageByNonce :one
SELECT * FROM messages WHERE author_id = @author_id AND nonce = @nonce;

-- name: ListMessagesBefore :many
-- ListMessagesBefore returns up to row_limit messages of a channel older than
-- the cursor (all when before is NULL), newest first, with their authors.
-- Deleted messages and replies kept in their thread are left out.
SELECT m.*, u.display_name AS author_name, u.is_bot AS author_is_bot
FROM messages m
JOIN users u ON u.id = m.author_id
WHERE m.channel_id = @channel_id
  AND m.deleted_at IS NULL
  AND (m.root_id IS NULL OR m.also_in_channel)
  AND (sqlc.narg(before)::uuid IS NULL OR m.id < sqlc.narg(before)::uuid)
ORDER BY m.id DESC
LIMIT @row_limit;

-- name: GetMessage :one
SELECT m.*, u.display_name AS author_name, u.is_bot AS author_is_bot
FROM messages m
JOIN users u ON u.id = m.author_id
WHERE m.id = @id AND m.channel_id = @channel_id;

-- name: EditMessage :one
UPDATE messages SET body = @body, edited_at = now()
WHERE id = @id AND deleted_at IS NULL
RETURNING *;

-- name: DeleteMessage :one
UPDATE messages SET deleted_at = now(), deleted_by = @deleted_by
WHERE id = @id AND deleted_at IS NULL
RETURNING *;

-- name: RestoreMessage :one
-- RestoreMessage brings back a message deleted less than restore_window ago.
UPDATE messages SET deleted_at = NULL, deleted_by = NULL
WHERE id = @id AND deleted_at > now() - sqlc.arg(restore_window)::interval
RETURNING *;

-- name: PurgeDeletedMessages :execrows
-- PurgeDeletedMessages removes messages that can no longer be restored.
-- Messages a legal hold keeps stay (for eDiscovery).
DELETE FROM messages WHERE deleted_at <= now() - sqlc.arg(restore_window)::interval
    AND NOT message_held(channel_id, author_id, created_at);

-- name: GetChannelByName :one
SELECT * FROM channels WHERE workspace_id = @workspace_id AND lower(name) = lower(@name);

-- name: CreateConversation :one
-- CreateConversation creates a direct or group conversation, or returns the
-- existing one with the same key (name).
INSERT INTO channels (workspace_id, name, kind, visibility, created_by)
VALUES (@workspace_id, @name, @kind, 'private', @created_by)
ON CONFLICT (workspace_id, (lower(name))) DO UPDATE SET name = EXCLUDED.name
RETURNING *;

-- name: ListConversationParticipants :many
-- ListConversationParticipants returns, for each direct or group conversation
-- of a user, the other people in it.
SELECT m.channel_id, u.id AS user_id, u.display_name, u.email
FROM channel_members me
JOIN channels c ON c.id = me.channel_id AND c.kind IN ('direct', 'group')
JOIN channel_members m ON m.channel_id = c.id AND m.user_id <> @user_id
JOIN users u ON u.id = m.user_id
WHERE me.user_id = @user_id
ORDER BY m.channel_id, lower(u.display_name);

-- name: MarkRead :execrows
-- MarkRead moves a member's read position forward (never back).
UPDATE channel_members SET last_read_id = @message_id
WHERE channel_id = @channel_id AND user_id = @user_id
  AND (last_read_id IS NULL OR last_read_id < @message_id);

-- name: MarkUnreadFrom :one
-- MarkUnreadFrom moves a member's read position back to just before a message,
-- so it and everything after it count as unread again.
UPDATE channel_members m SET last_read_id = (
    SELECT x.id FROM messages x
    WHERE x.channel_id = @channel_id AND x.id < @message_id
    ORDER BY x.id DESC LIMIT 1)
WHERE m.channel_id = @channel_id AND m.user_id = @user_id
RETURNING m.last_read_id;

-- name: NewestChannelMessage :one
-- NewestChannelMessage returns the newest message of others shown in a
-- channel's timeline (one's own messages never count as unread).
SELECT id FROM messages
WHERE channel_id = @channel_id AND deleted_at IS NULL AND (root_id IS NULL OR also_in_channel)
  AND author_id <> @user_id
ORDER BY id DESC LIMIT 1;

-- name: NewestTimelineMessage :one
-- NewestTimelineMessage returns the newest message shown in a channel's timeline.
SELECT id FROM messages
WHERE channel_id = @channel_id AND deleted_at IS NULL AND (root_id IS NULL OR also_in_channel)
ORDER BY id DESC LIMIT 1;

-- name: AddMessageEdit :exec
-- AddMessageEdit keeps the text an edit replaces.
INSERT INTO message_edits (message_id, body, written_at) VALUES (@message_id, @body, @written_at);

-- name: ListMessageEdits :many
-- ListMessageEdits returns a message's earlier versions, the newest first.
SELECT body, written_at, replaced_at FROM message_edits
WHERE message_id = @message_id ORDER BY id DESC LIMIT 200;

-- name: ListEditsOfMessages :many
-- ListEditsOfMessages returns the earlier versions of messages, oldest first.
SELECT message_id, body, written_at, replaced_at FROM message_edits
WHERE message_id = ANY(@message_ids::uuid[]) ORDER BY message_id, id;

-- name: ListMemberChannels :many
-- ListMemberChannels returns the channels a user belongs to with the user's
-- role: mandatory ones first, then by name.
SELECT sqlc.embed(c), m.role
FROM channels c
JOIN channel_members m ON m.channel_id = c.id AND m.user_id = @user_id
WHERE c.archived_at IS NULL
ORDER BY c.is_mandatory DESC, lower(c.name);

-- name: ListAllChannels :many
-- ListAllChannels returns the public channels and the private channels the
-- user belongs to, with the user's role ('' when not a member).
SELECT sqlc.embed(c), coalesce(m.role, '')::text AS role
FROM channels c
LEFT JOIN channel_members m ON m.channel_id = c.id AND m.user_id = @user_id
WHERE c.visibility = 'public' OR m.user_id IS NOT NULL
ORDER BY c.is_mandatory DESC, lower(c.name);

-- name: ListMemberChannelIDs :many
SELECT channel_id FROM channel_members WHERE user_id = @user_id;

-- name: GetChannel :one
SELECT * FROM channels WHERE id = @id;

-- name: GetMemberRole :one
-- GetMemberRole returns the user's role in a channel ('' when not a member).
SELECT coalesce((
    SELECT role FROM channel_members WHERE channel_id = @channel_id AND user_id = @user_id
), '')::text;

-- name: ListMembers :many
SELECT u.id, u.display_name, u.email, m.role, m.joined_at
FROM channel_members m
JOIN users u ON u.id = m.user_id
WHERE m.channel_id = @channel_id
ORDER BY m.role = 'manager' DESC, lower(u.display_name), u.id;

-- name: UpdateChannel :one
UPDATE channels
SET name = @name, visibility = @visibility, topic = @topic, category_id = sqlc.narg(category_id)
WHERE id = @id
RETURNING *;

-- name: SetChannelArchived :one
UPDATE channels
SET archived_at = CASE WHEN @archived::boolean THEN coalesce(archived_at, now()) END
WHERE id = @id
RETURNING *;

-- name: ListCategories :many
SELECT * FROM channel_categories ORDER BY position, lower(name);

-- name: GetCategory :one
SELECT * FROM channel_categories WHERE id = @id;

-- name: CreateCategory :one
INSERT INTO channel_categories (name, position)
VALUES (@name, coalesce((SELECT max(position) + 1 FROM channel_categories), 0))
RETURNING *;

-- name: UpdateCategory :one
UPDATE channel_categories SET name = @name, position = @position WHERE id = @id
RETURNING *;

-- name: DeleteCategory :execrows
DELETE FROM channel_categories WHERE id = @id;

-- name: CreateChannel :one
INSERT INTO channels (name, topic, kind, is_default, visibility, created_by)
VALUES (@name, @topic, @kind, @is_default, @visibility, @created_by)
RETURNING *;

-- name: EnsureChannel :one
-- EnsureChannel creates a configured channel or brings an existing one of that
-- name to the configured kind and flags (and public: everyone is a member);
-- the topic of an existing channel is kept.
INSERT INTO channels (name, topic, kind, is_default, is_mandatory)
VALUES (@name, @topic, @kind, @is_default, @is_mandatory)
ON CONFLICT ((lower(name))) DO UPDATE
SET kind = EXCLUDED.kind, is_default = EXCLUDED.is_default, is_mandatory = EXCLUDED.is_mandatory,
    visibility = 'public'
RETURNING *;

-- name: AddMember :execrows
INSERT INTO channel_members (channel_id, user_id, role) VALUES (@channel_id, @user_id, @role)
ON CONFLICT DO NOTHING;

-- name: RemoveMember :execrows
DELETE FROM channel_members WHERE channel_id = @channel_id AND user_id = @user_id;

-- name: AddAllUsers :execrows
-- AddAllUsers makes every user a member of a channel.
INSERT INTO channel_members (channel_id, user_id)
SELECT @channel_id, id FROM users
ON CONFLICT DO NOTHING;

-- name: JoinDefaultChannels :execrows
-- JoinDefaultChannels makes a user a member of every default channel.
INSERT INTO channel_members (channel_id, user_id)
SELECT id, @user_id FROM channels WHERE is_default
ON CONFLICT DO NOTHING;

-- name: CreateMessage :one
-- CreateMessage inserts a message; with a nonce the author used before it
-- returns nothing (see GetMessageByNonce).
INSERT INTO messages (channel_id, author_id, body, nonce)
VALUES (@channel_id, @author_id, @body, @nonce)
ON CONFLICT ON CONSTRAINT messages_author_nonce_key DO NOTHING
RETURNING *;

-- name: GetMessageByNonce :one
SELECT * FROM messages WHERE author_id = @author_id AND nonce = @nonce;

-- name: ListMessagesBefore :many
-- ListMessagesBefore returns up to row_limit messages of a channel older than
-- the cursor (all when before is NULL), newest first, with their authors.
-- Deleted messages are left out.
SELECT m.*, u.display_name AS author_name
FROM messages m
JOIN users u ON u.id = m.author_id
WHERE m.channel_id = @channel_id
  AND m.deleted_at IS NULL
  AND (sqlc.narg(before)::uuid IS NULL OR m.id < sqlc.narg(before)::uuid)
ORDER BY m.id DESC
LIMIT @row_limit;

-- name: GetMessage :one
SELECT m.*, u.display_name AS author_name
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
DELETE FROM messages WHERE deleted_at <= now() - sqlc.arg(restore_window)::interval;

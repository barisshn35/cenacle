-- name: GetProfiles :many
-- GetProfiles reads the profiles of people; an expired custom status reads
-- as none.
SELECT u.id, u.display_name, u.username, u.username_from_directory, u.email, u.is_bot,
       u.avatar_id, coalesce(p.content_type = 'image/gif', false)::boolean AS avatar_animated,
       u.timezone, u.show_last_seen, u.share_read_receipts, u.last_seen_at, u.deactivated_at, u.directory_role,
       CASE WHEN u.status_expires_at IS NULL OR u.status_expires_at > now() THEN u.status_emoji ELSE '' END::text AS status_emoji,
       CASE WHEN u.status_expires_at IS NULL OR u.status_expires_at > now() THEN u.status_text ELSE '' END::text AS status_text,
       u.status_expires_at,
       u.recent_statuses,
       -- Out of office, shown while it has not ended (it may start later).
       u.ooo_from, u.ooo_until, u.ooo_message,
       coalesce(u.ooo_until > now(), false)::boolean AS ooo_current
FROM users u
LEFT JOIN pictures p ON p.id = u.avatar_id
WHERE u.id = ANY(@ids::uuid[]);

-- name: UpdateProfileSettings :exec
UPDATE users SET
    username       = coalesce(sqlc.narg(username), username),
    timezone       = coalesce(sqlc.narg(timezone), timezone),
    show_last_seen = coalesce(sqlc.narg(show_last_seen), show_last_seen),
    share_read_receipts = coalesce(sqlc.narg(share_read_receipts), share_read_receipts),
    updated_at     = now()
WHERE id = @id;

-- name: UsernameTaken :one
SELECT EXISTS (SELECT 1 FROM users WHERE lower(username) = lower(@username) AND id <> @id);

-- name: AssignUsername :exec
-- AssignUsername gives someone without a @username one made from their
-- address or name (with a random suffix when it is taken).
UPDATE users u SET username = CASE
    WHEN NOT EXISTS (SELECT 1 FROM users x WHERE lower(x.username) = cenacle_username_base(u.email, u.display_name))
    THEN cenacle_username_base(u.email, u.display_name)
    ELSE cenacle_username_base(u.email, u.display_name) || '-' || substr(md5(random()::text), 1, 8) END
WHERE u.id = @id AND u.username IS NULL;

-- name: ReleaseUsername :exec
-- ReleaseUsername takes a @username from others when the directory gives it
-- to someone (they get a new one). The directory's present assignment wins
-- over one it made before: the previous holder gets their new name with
-- their own change.
UPDATE users SET username = NULL, username_from_directory = false
WHERE lower(username) = lower(@username) AND id <> @id;

-- name: UsersWithoutUsername :many
SELECT id FROM users WHERE username IS NULL LIMIT 100;

-- name: SetCustomStatus :exec
-- SetCustomStatus sets the custom status and puts it first in the recent
-- ones (five, without duplicates).
UPDATE users SET
    status_emoji = @emoji, status_text = @text, status_expires_at = sqlc.narg(expires_at),
    recent_statuses = (
        SELECT coalesce(jsonb_agg(s), '[]') FROM (
            SELECT s FROM (
                SELECT jsonb_build_object('emoji', @emoji::text, 'text', @text::text) AS s, 0 AS o
                UNION ALL
                SELECT e, ord FROM jsonb_array_elements(users.recent_statuses) WITH ORDINALITY AS t(e, ord)
                WHERE e <> jsonb_build_object('emoji', @emoji::text, 'text', @text::text)
            ) all_statuses ORDER BY o LIMIT 5
        ) recent),
    updated_at = now()
WHERE id = @id;

-- name: ClearCustomStatus :exec
UPDATE users SET status_emoji = '', status_text = '', status_expires_at = NULL, updated_at = now()
WHERE id = @id;

-- name: ClearExpiredStatuses :many
-- ClearExpiredStatuses empties custom statuses whose time is up.
UPDATE users SET status_emoji = '', status_text = '', status_expires_at = NULL, updated_at = now()
WHERE status_expires_at <= now()
RETURNING id;

-- name: SetLastSeen :exec
UPDATE users SET last_seen_at = now() WHERE id = @id;

-- name: InsertPicture :one
INSERT INTO pictures (content_type, data, still) VALUES (@content_type, @data, sqlc.narg(still))
RETURNING id;

-- name: GetPicture :one
SELECT id, content_type, data, still FROM pictures WHERE id = @id;

-- name: DeletePicture :exec
DELETE FROM pictures WHERE id = @id;

-- name: SetAvatar :one
-- SetAvatar changes the picture of a person and returns the previous one (to
-- delete).
UPDATE users u SET avatar_id = sqlc.narg(avatar_id), avatar_from_directory = @from_directory,
    updated_at = now()
FROM (SELECT x.id AS uid, x.avatar_id AS old_id FROM users x WHERE x.id = @id FOR UPDATE) old
WHERE u.id = old.uid
RETURNING old.old_id;

-- name: GetDirectoryPhoto :one
SELECT directory_photo, avatar_id, avatar_from_directory FROM users WHERE id = @id;

-- name: SetDirectoryPhoto :exec
UPDATE users SET directory_photo = @directory_photo WHERE id = @id;

-- name: SetWorkspaceIcon :one
UPDATE workspaces w SET icon_id = sqlc.narg(icon_id)
FROM (SELECT x.id AS wid, x.icon_id AS old_id FROM workspaces x WHERE x.id = @id FOR UPDATE) old
WHERE w.id = old.wid
RETURNING old.old_id;

-- name: WorkspacesSharedWith :many
-- WorkspacesSharedWith lists the workspaces of a person (their profile
-- changes go to everyone there).
SELECT workspace_id FROM workspace_members WHERE user_id = @user_id;

-- name: VisibleProfileIDs :many
-- VisibleProfileIDs keeps the people a viewer may see: themselves, bots,
-- people of their workspaces (guests: only of their channels) and people of
-- their channels and conversations.
SELECT u.id FROM users u
WHERE u.id = ANY(@ids::uuid[]) AND (
    u.id = @viewer OR u.is_bot
    OR EXISTS (SELECT 1 FROM workspace_members a
               JOIN workspace_members b ON b.workspace_id = a.workspace_id AND b.user_id = u.id
               WHERE a.user_id = @viewer AND a.role <> 'guest')
    OR EXISTS (SELECT 1 FROM channel_members a
               JOIN channel_members b ON b.channel_id = a.channel_id AND b.user_id = u.id
               WHERE a.user_id = @viewer));

-- name: SetOutOfOffice :exec
-- SetOutOfOffice sets an absence and forgets which conversations got the
-- automatic reply of the one before.
WITH forget AS (DELETE FROM ooo_replies WHERE user_id = @id)
UPDATE users SET ooo_from = @from_at, ooo_until = @until_at, ooo_message = @message, updated_at = now()
WHERE id = @id;

-- name: ClearOutOfOffice :exec
UPDATE users SET ooo_from = NULL, ooo_until = NULL, ooo_message = '', updated_at = now() WHERE id = @id;

-- name: ClaimOutOfOfficeReplies :many
-- ClaimOutOfOfficeReplies returns the people of a conversation (not the
-- sender) who are away now and have not answered it automatically in this
-- absence, and notes that they now have.
INSERT INTO ooo_replies (user_id, channel_id)
SELECT u.id, @channel_id::uuid
FROM channel_members m JOIN users u ON u.id = m.user_id
WHERE m.channel_id = @channel_id AND m.user_id <> @sender_id
  AND u.ooo_from <= now() AND u.ooo_until > now()
  AND u.deactivated_at IS NULL AND NOT u.is_bot
ON CONFLICT DO NOTHING
RETURNING user_id;

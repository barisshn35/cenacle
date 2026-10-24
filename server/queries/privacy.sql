-- name: UserMessagesAfter :many
-- UserMessagesAfter returns the messages a person wrote, oldest first, after a
-- cursor (their data export).
SELECT m.id, m.channel_id, c.name AS channel_name, m.root_id, m.body, m.created_at, m.edited_at, m.deleted_at, m.has_files
FROM messages m JOIN channels c ON c.id = m.channel_id
WHERE m.author_id = @author_id AND (sqlc.narg(after)::uuid IS NULL OR m.id > sqlc.narg(after)::uuid)
ORDER BY m.id
LIMIT @row_limit;

-- name: UserWorkspaces :many
SELECT w.id, w.name, wm.role FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id
WHERE wm.user_id = @user_id ORDER BY lower(w.name);

-- name: UserChannels :many
SELECT c.id, c.name, c.kind, c.workspace_id, cm.role FROM channel_members cm JOIN channels c ON c.id = cm.channel_id
WHERE cm.user_id = @user_id ORDER BY c.id;

-- name: UserReactions :many
SELECT message_id, emoji, created_at FROM message_reactions WHERE user_id = @user_id ORDER BY created_at;

-- name: UserFiles :many
SELECT id, channel_id, message_id, name, content_type, size, status, created_at FROM files
WHERE uploader_id = @user_id ORDER BY id;

-- name: UserSessionsAll :many
SELECT created_at, last_seen_at, expires_at, user_agent, ip_address FROM sessions WHERE user_id = @user_id ORDER BY id;

-- name: UserAuditEvents :many
SELECT id, at, action, workspace_id, target_type, target_id, ip_address, detail FROM audit_events
WHERE actor_id = @user_id ORDER BY id;

-- name: EraseUserMessages :one
-- EraseUserMessages deletes a person's messages that no legal hold keeps (the
-- purge removes them for good within the restore window) and counts those kept.
WITH erased AS (
    UPDATE messages m SET deleted_at = coalesce(m.deleted_at, now()), deleted_by = coalesce(m.deleted_by, @erased_by)
    WHERE m.author_id = @user_id AND NOT message_held(m.channel_id, m.author_id, m.created_at)
    RETURNING m.id
), edits AS (
    DELETE FROM message_edits WHERE message_id IN (SELECT id FROM erased) RETURNING 1
)
SELECT (SELECT count(*) FROM erased)::int AS erased,
       (SELECT count(*) FROM messages h WHERE h.author_id = @user_id AND message_held(h.channel_id, h.author_id, h.created_at))::int AS held,
       (SELECT count(*) FROM edits)::int AS edits;

-- name: EraseUserTraces :exec
-- EraseUserTraces removes what a person kept or set for themselves.
SELECT erase_user_traces(@user_id::uuid);

-- name: EraseUser :one
-- EraseUser anonymizes an account: no name, address, picture or status; it can
-- no longer sign in (a new sign-in makes a new account).
UPDATE users SET display_name = @display_name, email = '', email_verified = false, username = NULL,
    avatar_id = NULL, avatar_from_directory = false, directory_photo = '', timezone = '',
    status_emoji = '', status_text = '', status_expires_at = NULL, recent_statuses = '[]',
    auth_service = 'erased', auth_data = 'erased:' || id::text, directory_role = NULL, is_admin = false,
    deactivated_at = coalesce(deactivated_at, now()), last_seen_at = NULL, updated_at = now()
WHERE id = @id AND NOT is_bot
RETURNING *;

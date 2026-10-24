-- Reading a workspace for a Cenacle export (server export).

-- name: MoveExportWorkspaces :many
-- MoveExportWorkspaces lists the workspaces to export: the named ones, or all.
SELECT * FROM workspaces
WHERE cardinality(@names::text[]) = 0 OR name = ANY(@names::text[])
ORDER BY created_at;

-- name: MoveExportWorkspaceMembers :many
SELECT user_id, role FROM workspace_members WHERE workspace_id = @workspace_id ORDER BY joined_at;

-- name: MoveExportChannels :many
-- MoveExportChannels lists the channels and conversations of a workspace.
SELECT * FROM channels WHERE workspace_id = @workspace_id ORDER BY created_at, id;

-- name: MoveExportChannelMembers :many
SELECT user_id, role FROM channel_members WHERE channel_id = @channel_id ORDER BY user_id;

-- name: MoveExportUsers :many
SELECT id, auth_service, auth_data, email, display_name FROM users WHERE id = ANY(@ids::uuid[]) ORDER BY id;

-- name: MoveExportMessages :many
-- MoveExportMessages pages through the messages of a channel that are not
-- deleted, oldest first (roots before their replies).
SELECT id, author_id, body, created_at, root_id, also_in_channel, pinned_at, title, tags, has_files
FROM messages
WHERE channel_id = @channel_id AND deleted_at IS NULL AND id > @after
ORDER BY id
LIMIT @page_size;

-- name: MoveExportReactions :many
SELECT message_id, emoji, user_id FROM message_reactions
WHERE message_id = ANY(@message_ids::uuid[]) ORDER BY message_id, emoji, created_at;

-- name: MoveExportFiles :many
SELECT * FROM files WHERE message_id = ANY(@message_ids::uuid[]) AND status = 'ready' ORDER BY id;

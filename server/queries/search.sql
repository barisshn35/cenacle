-- name: SearchMessages :many
-- SearchMessages finds messages of the channels and conversations the user is
-- in, newest first, with filters; before is the cursor (a message id).
SELECT m.id, m.channel_id, m.author_id, m.body, m.created_at, m.edited_at, m.has_files, m.root_id,
       u.display_name AS author_name, u.is_bot AS author_is_bot,
       c.name AS channel_name, c.kind AS channel_kind, c.workspace_id
FROM messages m
JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id = @user_id
JOIN channels c ON c.id = m.channel_id
JOIN users u ON u.id = m.author_id
WHERE m.deleted_at IS NULL
  AND cenacle_search_vector(m.body) @@ cenacle_search_query(@query)
  AND (sqlc.narg(workspace_id)::uuid IS NULL OR c.workspace_id = sqlc.narg(workspace_id)::uuid)
  AND (sqlc.narg(channel_id)::uuid IS NULL OR m.channel_id = sqlc.narg(channel_id)::uuid)
  AND (sqlc.narg(author_id)::uuid IS NULL OR m.author_id = sqlc.narg(author_id)::uuid)
  AND (sqlc.narg(after)::timestamptz IS NULL OR m.created_at >= sqlc.narg(after)::timestamptz)
  AND (sqlc.narg(until)::timestamptz IS NULL OR m.created_at < sqlc.narg(until)::timestamptz)
  AND (NOT @has_files::boolean OR m.has_files)
  AND (NOT @has_link::boolean OR m.body ~* 'https?://')
  AND (sqlc.narg(before)::uuid IS NULL OR m.id < sqlc.narg(before)::uuid)
ORDER BY m.id DESC
LIMIT @row_limit;

-- name: SearchFiles :many
-- SearchFiles finds files by name in the user's channels, newest first.
SELECT f.id, f.channel_id, f.message_id, f.name, f.content_type, f.size, f.width, f.height,
       f.has_thumbnail, f.created_at, u.id AS uploader_id, u.display_name AS uploader_name,
       c.name AS channel_name, c.kind AS channel_kind, c.workspace_id
FROM files f
JOIN channel_members cm ON cm.channel_id = f.channel_id AND cm.user_id = @user_id
JOIN channels c ON c.id = f.channel_id
JOIN users u ON u.id = f.uploader_id
WHERE f.message_id IS NOT NULL AND f.status = 'ready'
  AND cenacle_search_vector(f.name) @@ cenacle_search_query(@query)
  AND (sqlc.narg(workspace_id)::uuid IS NULL OR c.workspace_id = sqlc.narg(workspace_id)::uuid)
  AND (sqlc.narg(before)::uuid IS NULL OR f.id < sqlc.narg(before)::uuid)
ORDER BY f.id DESC
LIMIT @row_limit;

-- name: SearchQueryValid :one
SELECT (cenacle_search_query(@query) IS NOT NULL)::boolean;

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
WHERE m.deleted_at IS NULL AND m.burn_seconds IS NULL AND NOT c.encrypted
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
-- SearchFiles finds files by name or by their text in the user's channels,
-- newest first, with the matching words of the text.
SELECT f.id, f.channel_id, f.message_id, f.name, f.content_type, f.size, f.width, f.height,
       f.has_thumbnail, f.created_at, u.id AS uploader_id, u.display_name AS uploader_name,
       c.name AS channel_name, c.kind AS channel_kind, c.workspace_id,
       (f.content_text IS NOT NULL AND cenacle_search_vector(f.content_text) @@ cenacle_search_query(@query))::boolean AS in_content,
       CASE WHEN f.content_text IS NOT NULL AND cenacle_search_vector(f.content_text) @@ cenacle_search_query(@query)
            THEN left(f.content_text, 20000) ELSE '' END::text AS content_head
FROM files f
JOIN channel_members cm ON cm.channel_id = f.channel_id AND cm.user_id = @user_id
JOIN channels c ON c.id = f.channel_id
JOIN users u ON u.id = f.uploader_id
WHERE f.message_id IS NOT NULL AND f.status = 'ready'
  AND (cenacle_search_vector(f.name) @@ cenacle_search_query(@query)
       OR (f.content_text IS NOT NULL AND cenacle_search_vector(f.content_text) @@ cenacle_search_query(@query)))
  AND (sqlc.narg(workspace_id)::uuid IS NULL OR c.workspace_id = sqlc.narg(workspace_id)::uuid)
  AND (sqlc.narg(before)::uuid IS NULL OR f.id < sqlc.narg(before)::uuid)
ORDER BY f.id DESC
LIMIT @row_limit;

-- name: SearchQueryValid :one
SELECT (cenacle_search_query(@query) IS NOT NULL)::boolean;

-- name: SearchCanvases :many
-- SearchCanvases finds canvases of the user's channels by their text.
SELECT t.id AS tab_id, t.title, t.channel_id, c.name AS channel_name, c.kind AS channel_kind, c.workspace_id,
       v.updated_at,
       left(v.body, 20000)::text AS content_head
FROM canvases v
JOIN channel_tabs t ON t.canvas_id = v.id
JOIN channel_members cm ON cm.channel_id = v.channel_id AND cm.user_id = @user_id
JOIN channels c ON c.id = v.channel_id
WHERE cenacle_search_vector(v.body) @@ cenacle_search_query(@query)
  AND (sqlc.narg(workspace_id)::uuid IS NULL OR c.workspace_id = sqlc.narg(workspace_id)::uuid)
ORDER BY v.updated_at DESC
LIMIT 20;

-- name: SearchListItems :many
-- SearchListItems finds rows of the lists of the user's channels.
SELECT i.id, i.title AS item_title, t.id AS tab_id, t.title AS list_title, t.channel_id,
       c.name AS channel_name, c.kind AS channel_kind, c.workspace_id, i.updated_at
FROM list_items i
JOIN channel_tabs t ON t.list_id = i.list_id
JOIN lists l ON l.id = i.list_id
JOIN channel_members cm ON cm.channel_id = l.channel_id AND cm.user_id = @user_id
JOIN channels c ON c.id = l.channel_id
WHERE cenacle_search_vector(i.title || ' ' || i."values"::text) @@ cenacle_search_query(@query)
  AND (sqlc.narg(workspace_id)::uuid IS NULL OR c.workspace_id = sqlc.narg(workspace_id)::uuid)
ORDER BY i.updated_at DESC
LIMIT 20;

-- name: PendingFileTexts :many
SELECT id, name, content_type, size FROM files
WHERE content_state = 'pending' AND status = 'ready'
ORDER BY id
LIMIT @row_limit;

-- name: SetFileText :exec
UPDATE files SET content_text = sqlc.narg(content_text), content_state = @content_state WHERE id = @id;

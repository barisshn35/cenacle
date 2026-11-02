-- name: ArchiveMessages :many
-- ArchiveMessages returns a page of a workspace's messages written in a
-- period, oldest first, with what archive formats need.
SELECT m.id, m.channel_id, c.name AS channel_name, c.kind AS channel_kind, m.author_id,
    coalesce(u.display_name, '')::text AS author_name, coalesce(u.email, '')::text AS author_email,
    m.body, m.root_id, m.created_at, m.edited_at, m.deleted_at,
    coalesce((SELECT array_agg(f.name ORDER BY f.id) FROM files f WHERE f.message_id = m.id), '{}')::text[] AS file_names
FROM messages m
JOIN channels c ON c.id = m.channel_id
LEFT JOIN users u ON u.id = m.author_id
WHERE c.workspace_id = @workspace_id
  AND m.created_at >= @since AND m.created_at < @until
  AND (sqlc.narg(after)::uuid IS NULL OR m.id > sqlc.narg(after)::uuid)
ORDER BY m.id
LIMIT @row_limit;

-- name: SetArchiveFormat :exec
-- SetArchiveFormat turns daily exports on (from yesterday) or off.
UPDATE workspaces SET archive_format = @format,
    archive_last_day = CASE WHEN @format::text = '' THEN NULL ELSE coalesce(archive_last_day, (now() AT TIME ZONE 'UTC')::date - 2) END
WHERE id = @id;

-- name: ListArchiveExports :many
SELECT * FROM archive_exports WHERE workspace_id = @workspace_id ORDER BY day DESC, id DESC LIMIT 60;

-- name: GetArchiveExport :one
SELECT * FROM archive_exports WHERE id = @id;

-- name: CreateArchiveExport :one
INSERT INTO archive_exports (workspace_id, format, day, object_key, size, messages)
VALUES (@workspace_id, @format, @day, @object_key, @size, @messages)
ON CONFLICT (workspace_id, format, day) DO UPDATE SET object_key = EXCLUDED.object_key, size = EXCLUDED.size,
    messages = EXCLUDED.messages, created_at = now()
RETURNING *;

-- name: WorkspacesDueForArchive :many
-- WorkspacesDueForArchive are those with daily exports and a whole day not exported yet.
SELECT id, archive_format, archive_last_day FROM workspaces
WHERE archive_format <> '' AND archive_last_day < (now() AT TIME ZONE 'UTC')::date - 1
ORDER BY id
LIMIT 20;

-- name: SetArchiveLastDay :exec
UPDATE workspaces SET archive_last_day = @day WHERE id = @id;

-- name: MarkArchiveStale :execrows
-- MarkArchiveStale marks the daily export holding a message to be written again.
UPDATE archive_exports e SET stale_at = now()
FROM messages m JOIN channels c ON c.id = m.channel_id
WHERE m.id = @message_id AND e.workspace_id = c.workspace_id AND e.day = (m.created_at AT TIME ZONE 'UTC')::date;

-- name: MarkArchiveStaleForAuthor :exec
-- MarkArchiveStaleForAuthor marks the daily exports holding a person's
-- messages (their name and address) to be written again.
UPDATE archive_exports e SET stale_at = now()
FROM (SELECT DISTINCT c.workspace_id, (m.created_at AT TIME ZONE 'UTC')::date AS day
      FROM messages m JOIN channels c ON c.id = m.channel_id
      WHERE m.author_id = @author_id) d
WHERE e.workspace_id = d.workspace_id AND e.day = d.day;

-- name: ListStaleArchiveExports :many
SELECT * FROM archive_exports WHERE stale_at IS NOT NULL ORDER BY stale_at LIMIT @row_limit;

-- name: RewroteArchiveExport :execrows
-- RewroteArchiveExport records a stale export written again, unless it was
-- marked again meanwhile.
UPDATE archive_exports SET size = @size, messages = @messages, stale_at = NULL, created_at = now()
WHERE id = @id AND stale_at = @stale_at;

-- name: DeleteStaleArchiveExport :execrows
DELETE FROM archive_exports WHERE id = @id AND stale_at = @stale_at;

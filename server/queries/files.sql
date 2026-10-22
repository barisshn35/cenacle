-- name: CreateFile :one
INSERT INTO files (workspace_id, channel_id, uploader_id, name, content_type, size, media_kind, duration_ms, waveform)
VALUES (@workspace_id, @channel_id, @uploader_id, @name, @content_type, @size,
        sqlc.narg(media_kind), sqlc.narg(duration_ms), sqlc.narg(waveform))
RETURNING *;

-- name: CountUnsentFiles :one
-- CountUnsentFiles counts a person's uploads that no message carries yet.
SELECT count(*) FROM files WHERE uploader_id = @uploader_id AND message_id IS NULL AND attached_at IS NULL;

-- name: GetFile :one
SELECT * FROM files WHERE id = @id;

-- name: GetFileForReader :one
-- GetFileForReader returns a file with the message it belongs to (deleted
-- messages hide their files).
SELECT f.*, (m.deleted_at IS NOT NULL)::boolean AS message_deleted
FROM files f LEFT JOIN messages m ON m.id = f.message_id
WHERE f.id = @id;

-- name: FinishUpload :one
-- FinishUpload records what the server found out about an uploaded file.
UPDATE files SET status = @status, content_type = @content_type, width = sqlc.narg(width),
    height = sqlc.narg(height), has_thumbnail = @has_thumbnail
WHERE id = @id AND status = 'uploading'
RETURNING *;

-- name: AttachFiles :execrows
-- AttachFiles gives a new message the uploader's ready files of the channel
-- that no message carries yet.
UPDATE files SET message_id = @message_id, attached_at = now()
WHERE id = ANY(@ids::uuid[]) AND uploader_id = @uploader_id AND channel_id = @channel_id
  AND status = 'ready' AND message_id IS NULL;

-- name: ListMessageFiles :many
SELECT * FROM files WHERE message_id = ANY(@message_ids::uuid[]) ORDER BY id;

-- name: ListChannelFiles :many
-- ListChannelFiles is the files tab: files of the channel's visible messages,
-- newest first, with their uploaders.
SELECT f.*, u.display_name AS uploader_name
FROM files f
JOIN messages m ON m.id = f.message_id AND m.deleted_at IS NULL
JOIN users u ON u.id = f.uploader_id
WHERE f.channel_id = @channel_id AND f.status = 'ready'
  AND (sqlc.narg(before)::uuid IS NULL OR f.id < sqlc.narg(before)::uuid)
ORDER BY f.id DESC
LIMIT @row_limit;

-- name: DeleteUnattachedFile :one
DELETE FROM files WHERE id = @id AND uploader_id = @uploader_id AND message_id IS NULL
RETURNING *;

-- name: ListStaleFiles :many
-- ListStaleFiles finds files to remove: uploads never sent with a message
-- within a day, and files whose message was purged.
SELECT * FROM files
WHERE message_id IS NULL AND (attached_at IS NOT NULL OR created_at < now() - interval '1 day')
ORDER BY created_at
LIMIT @row_limit;

-- name: DeleteFiles :exec
DELETE FROM files WHERE id = ANY(@ids::uuid[]);

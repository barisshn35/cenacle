-- name: ListChannels :many
SELECT * FROM channels ORDER BY name;

-- name: GetChannel :one
SELECT * FROM channels WHERE id = @id;

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
SELECT m.*, u.display_name AS author_name
FROM messages m
JOIN users u ON u.id = m.author_id
WHERE m.channel_id = @channel_id
  AND (sqlc.narg(before)::uuid IS NULL OR m.id < sqlc.narg(before)::uuid)
ORDER BY m.id DESC
LIMIT @row_limit;

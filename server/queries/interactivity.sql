-- name: SetBotInteractions :exec
UPDATE bots SET interactions_url = sqlc.narg(url), interactions_secret = sqlc.narg(secret) WHERE id = @id;

-- name: GetInteractiveBot :one
-- GetInteractiveBot returns the bot behind a user, when it receives interactions
-- and is enabled.
SELECT b.id, b.workspace_id, b.interactions_url::text AS url, b.interactions_secret::text AS secret
FROM bots b
WHERE b.user_id = @user_id AND b.disabled_at IS NULL AND b.interactions_url IS NOT NULL;

-- name: UpdateMessageByBot :one
-- UpdateMessageByBot replaces the text and cards of a bot's message (answering
-- an interaction); it is not marked edited.
UPDATE messages SET body = @body, attachments = @attachments
WHERE id = @id AND deleted_at IS NULL
RETURNING *;

-- name: CreateDialog :one
INSERT INTO dialogs (bot_id, user_id, channel_id, message_id, spec)
VALUES (@bot_id, @user_id, @channel_id, sqlc.narg(message_id), @spec)
RETURNING id;

-- name: GetDialog :one
SELECT d.*, b.user_id AS bot_user_id, b.interactions_url::text AS url, b.interactions_secret::text AS secret
FROM dialogs d JOIN bots b ON b.id = d.bot_id
WHERE d.id = @id AND d.user_id = @user_id AND d.expires_at > now()
  AND b.disabled_at IS NULL AND b.interactions_url IS NOT NULL;

-- name: DeleteDialog :exec
DELETE FROM dialogs WHERE id = @id;

-- name: PurgeDialogs :execrows
DELETE FROM dialogs WHERE expires_at <= now();

-- name: CreateFeed :one
INSERT INTO channel_feeds (channel_id, url, title, seen, created_by)
VALUES (@channel_id, @url, @title, @seen, @created_by)
RETURNING *;

-- name: DeleteFeed :execrows
DELETE FROM channel_feeds WHERE channel_id = @channel_id AND url = @url;

-- name: ListChannelFeeds :many
SELECT * FROM channel_feeds WHERE channel_id = @channel_id ORDER BY created_at;

-- name: CountChannelFeeds :one
SELECT count(*)::int FROM channel_feeds WHERE channel_id = @channel_id;

-- name: DueFeeds :many
-- DueFeeds lists feeds to read again: every 15 minutes, less often after
-- failures (up to every 8 hours), in channels that are not archived.
SELECT f.*, c.workspace_id, c.encrypted
FROM channel_feeds f JOIN channels c ON c.id = f.channel_id AND c.archived_at IS NULL
WHERE f.checked_at IS NULL
   OR f.checked_at < now() - make_interval(mins => 15 * (1 << least(f.failures, 5)))
ORDER BY f.checked_at NULLS FIRST
LIMIT 50;

-- name: FeedChecked :exec
UPDATE channel_feeds SET seen = @seen, title = @title, etag = @etag, last_modified = @last_modified,
    checked_at = now(), failures = 0, last_error = ''
WHERE id = @id;

-- name: FeedFailed :exec
UPDATE channel_feeds SET checked_at = now(), failures = failures + 1, last_error = @last_error WHERE id = @id;

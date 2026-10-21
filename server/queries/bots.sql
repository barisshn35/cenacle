-- name: CreateBotUser :one
INSERT INTO users (auth_service, auth_data, display_name, is_bot)
VALUES ('bot', @auth_data, @display_name, true)
RETURNING *;

-- name: CreateBot :one
INSERT INTO bots (id, workspace_id, user_id, description, created_by)
VALUES (@id, @workspace_id, @user_id, @description, @created_by)
RETURNING *;

-- name: ListBots :many
SELECT sqlc.embed(b), u.display_name
FROM bots b JOIN users u ON u.id = b.user_id
WHERE b.workspace_id = @workspace_id
ORDER BY lower(u.display_name), b.id;

-- name: GetBot :one
SELECT sqlc.embed(b), u.display_name
FROM bots b JOIN users u ON u.id = b.user_id
WHERE b.id = @id;

-- name: SetBotDisabled :one
UPDATE bots SET disabled_at = CASE WHEN @disabled::boolean THEN coalesce(disabled_at, now()) END
WHERE id = @id
RETURNING *;

-- name: UpdateBot :exec
UPDATE users SET display_name = @display_name, updated_at = now()
WHERE id = (SELECT user_id FROM bots WHERE bots.id = @bot_id);

-- name: SetBotDescription :exec
UPDATE bots SET description = @description WHERE id = @id;

-- name: CreateBotToken :one
INSERT INTO bot_tokens (bot_id, name, token_hash, scopes, created_by, expires_at)
VALUES (@bot_id, @name, @token_hash, @scopes, @created_by, sqlc.narg(expires_at))
RETURNING *;

-- name: ListBotTokens :many
SELECT * FROM bot_tokens WHERE bot_id = @bot_id AND revoked_at IS NULL ORDER BY created_at DESC;

-- name: RevokeBotToken :execrows
UPDATE bot_tokens SET revoked_at = now()
WHERE id = @id AND bot_id = @bot_id AND revoked_at IS NULL;

-- name: GetActiveBotToken :one
-- GetActiveBotToken returns a usable token with its bot and the bot's user.
SELECT sqlc.embed(t), sqlc.embed(b), sqlc.embed(u)
FROM bot_tokens t
JOIN bots b ON b.id = t.bot_id
JOIN users u ON u.id = b.user_id
WHERE t.token_hash = @token_hash AND t.revoked_at IS NULL
  AND (t.expires_at IS NULL OR t.expires_at > now()) AND b.disabled_at IS NULL;

-- name: TouchBotToken :exec
UPDATE bot_tokens SET last_used_at = now()
WHERE id = @id AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute');

-- name: CreateWebhook :one
INSERT INTO incoming_webhooks (bot_id, channel_id, kind, name, token_hash, created_by)
VALUES (@bot_id, @channel_id, @kind, @name, @token_hash, @created_by)
RETURNING *;

-- name: ListWebhooks :many
SELECT w.*, c.name AS channel_name
FROM incoming_webhooks w JOIN channels c ON c.id = w.channel_id
WHERE w.bot_id = @bot_id
ORDER BY w.created_at DESC;

-- name: DeleteWebhook :execrows
DELETE FROM incoming_webhooks WHERE id = @id AND bot_id = @bot_id;

-- name: GetActiveWebhook :one
-- GetActiveWebhook returns a webhook of an enabled bot with the bot's user.
SELECT sqlc.embed(w), sqlc.embed(u)
FROM incoming_webhooks w
JOIN bots b ON b.id = w.bot_id
JOIN users u ON u.id = b.user_id
WHERE w.token_hash = @token_hash AND b.disabled_at IS NULL;

-- name: TouchWebhook :exec
UPDATE incoming_webhooks SET last_used_at = now()
WHERE id = @id AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute');

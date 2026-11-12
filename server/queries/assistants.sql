-- Assistants over MCP (ADR 0056).

-- name: CreateAssistantToken :one
INSERT INTO assistant_tokens (user_id, name, token_hash, scopes, expires_at)
VALUES (@user_id, @name, @token_hash, @scopes, @expires_at)
RETURNING id, name, scopes, created_at, expires_at, last_used_at;

-- name: ListAssistantTokens :many
SELECT id, name, scopes, created_at, expires_at, last_used_at FROM assistant_tokens
WHERE user_id = @user_id AND revoked_at IS NULL AND expires_at > now()
ORDER BY created_at DESC;

-- name: CountAssistantTokens :one
SELECT count(*) FROM assistant_tokens WHERE user_id = @user_id AND revoked_at IS NULL AND expires_at > now();

-- name: RevokeAssistantToken :execrows
UPDATE assistant_tokens SET revoked_at = now() WHERE id = @id AND user_id = @user_id AND revoked_at IS NULL;

-- name: RevokeUserAssistantTokens :exec
UPDATE assistant_tokens SET revoked_at = now() WHERE user_id = @user_id AND revoked_at IS NULL;

-- name: GetActiveAssistantToken :one
-- A token that works now: not revoked or expired, its person active, and the
-- installation allowing assistants.
SELECT sqlc.embed(t), sqlc.embed(u) FROM assistant_tokens t JOIN users u ON u.id = t.user_id
WHERE t.token_hash = @token_hash AND t.revoked_at IS NULL AND t.expires_at > now()
  AND u.deactivated_at IS NULL AND (SELECT assistants_enabled FROM instance_settings);

-- name: TouchAssistantToken :exec
UPDATE assistant_tokens SET last_used_at = now()
WHERE id = @id AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute');

-- name: SetAssistantDraft :exec
INSERT INTO assistant_drafts (user_id, channel_id, root_id, body, token_id)
VALUES (@user_id, @channel_id, sqlc.narg(root_id), @body, @token_id)
ON CONFLICT (user_id, channel_id) DO UPDATE
SET root_id = EXCLUDED.root_id, body = EXCLUDED.body, token_id = EXCLUDED.token_id, created_at = now();

-- name: ListAssistantDrafts :many
SELECT d.channel_id, d.root_id, d.body, d.created_at, coalesce(t.name, '')::text AS assistant
FROM assistant_drafts d LEFT JOIN assistant_tokens t ON t.id = d.token_id
WHERE d.user_id = @user_id
ORDER BY d.created_at DESC;

-- name: DeleteAssistantDraft :execrows
DELETE FROM assistant_drafts WHERE user_id = @user_id AND channel_id = @channel_id;

-- name: MCPChannels :many
-- The channels and conversations a person is in (never encrypted ones).
SELECT c.id, c.workspace_id, c.name, c.kind, c.title, c.topic, w.name AS workspace_name
FROM channel_members cm JOIN channels c ON c.id = cm.channel_id JOIN workspaces w ON w.id = c.workspace_id
WHERE cm.user_id = @user_id AND NOT c.encrypted AND c.archived_at IS NULL
ORDER BY w.name, c.kind, c.name
LIMIT 500;

-- name: MCPChannelFor :one
-- A channel the person is in (never an encrypted one).
SELECT c.id, c.workspace_id, c.name, c.kind, c.title FROM channels c
JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = @user_id
WHERE c.id = @id AND NOT c.encrypted;

-- name: MCPMessages :many
-- A channel's messages, newest first, before a message (a page), with the
-- number of replies of each thread root.
SELECT m.id, m.root_id, m.body, m.created_at, m.edited_at, m.has_files, u.display_name AS author_name,
    (SELECT count(*) FROM messages r WHERE r.root_id = m.id AND r.deleted_at IS NULL)::int AS replies
FROM messages m JOIN users u ON u.id = m.author_id
WHERE m.channel_id = @channel_id AND m.deleted_at IS NULL AND m.burn_seconds IS NULL
  AND (sqlc.narg(root_id)::uuid IS NULL AND m.root_id IS NULL OR m.root_id = sqlc.narg(root_id)::uuid OR m.id = sqlc.narg(root_id)::uuid)
  AND (sqlc.narg(before)::uuid IS NULL OR m.id < sqlc.narg(before)::uuid)
ORDER BY m.id DESC
LIMIT @row_limit;

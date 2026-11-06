-- name: SetWorkspaceAI :one
UPDATE workspaces SET ai_enabled = @ai_enabled WHERE id = @id RETURNING *;

-- name: GetWorkspaceAI :one
SELECT ai_enabled FROM workspaces WHERE id = @id;

-- name: CountRecentAIRequests :one
SELECT count(*)::int FROM ai_requests WHERE user_id = @user_id AND created_at > now() - interval '10 minutes';

-- name: RecordAIRequest :exec
INSERT INTO ai_requests (workspace_id, user_id, kind, input_chars, output_chars)
VALUES (@workspace_id, @user_id, @kind, @input_chars, @output_chars);

-- name: ListMessagesForAI :many
-- ListMessagesForAI returns the newest readable messages of a channel (or of
-- a thread: its root and replies), newest first.
SELECT m.id, m.body, m.created_at, coalesce(u.display_name, '') AS author_name
FROM messages m LEFT JOIN users u ON u.id = m.author_id
WHERE m.channel_id = @channel_id AND m.deleted_at IS NULL AND m.burn_seconds IS NULL AND m.body <> ''
  AND (sqlc.narg(root_id)::uuid IS NULL OR m.id = sqlc.narg(root_id) OR m.root_id = sqlc.narg(root_id))
  AND (sqlc.narg(root_id)::uuid IS NOT NULL OR m.root_id IS NULL OR m.also_in_channel)
ORDER BY m.id DESC
LIMIT @row_limit;

-- name: SearchMessagesForAI :many
-- SearchMessagesForAI finds the messages of a workspace's channels a person
-- is in that best match any of the words (never encrypted channels).
SELECT m.id, m.channel_id, m.body, m.created_at, c.name AS channel_name, c.kind AS channel_kind,
    coalesce(u.display_name, '') AS author_name
FROM messages m
JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id = @user_id
JOIN channels c ON c.id = m.channel_id
LEFT JOIN users u ON u.id = m.author_id
WHERE c.workspace_id = @workspace_id AND NOT c.encrypted
  AND m.deleted_at IS NULL AND m.burn_seconds IS NULL
  AND cenacle_search_vector(m.body) @@ to_tsquery('simple'::regconfig, @tsquery::text)
ORDER BY ts_rank(cenacle_search_vector(m.body), to_tsquery('simple'::regconfig, @tsquery::text)) DESC, m.id DESC
LIMIT @row_limit;

-- name: GetAIConsent :one
SELECT * FROM ai_consents WHERE user_id = @user_id;

-- name: SetAIConsent :one
INSERT INTO ai_consents (user_id, accepted, model) VALUES (@user_id, @accepted, @model)
ON CONFLICT (user_id) DO UPDATE SET accepted = excluded.accepted, model = excluded.model, decided_at = now()
RETURNING *;

-- name: PruneAIRequests :execrows
-- PruneAIRequests deletes up to row_limit records of AI requests from before the
-- cut-off (CENACLE_AI_REQUEST_RETENTION), along the primary key like audit events.
DELETE FROM ai_requests WHERE id IN (
    SELECT r.id FROM ai_requests r
    WHERE r.id < (lpad(to_hex(floor(extract(epoch FROM @before::timestamptz) * 1000)::bigint), 12, '0')
                  || '70008000000000000000')::uuid
      AND r.created_at < @before::timestamptz
    ORDER BY r.id
    LIMIT @row_limit
);

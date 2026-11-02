-- name: GetCompliance :one
SELECT retention_days, classification_id FROM workspaces WHERE id = @id;

-- name: SetWorkspaceCompliance :exec
UPDATE workspaces SET retention_days = sqlc.narg(retention_days), classification_id = sqlc.narg(classification_id)
WHERE id = @id;

-- name: SetChannelCompliance :one
UPDATE channels SET retention_days = sqlc.narg(retention_days), classification_id = sqlc.narg(classification_id),
    access_rules = @access_rules
WHERE id = @id
RETURNING *;

-- name: PurgeExpiredMessages :execrows
-- PurgeExpiredMessages deletes up to row_limit messages older than their
-- channel's (or workspace's) retention, except those a legal hold keeps
-- (thread roots too while it keeps one of their replies).
-- Only channels with a retention are read, each through its (channel_id, id)
-- index: message ids are UUIDv7 made from the message's time (imported ones
-- too), so the oldest id of the cut-off's millisecond bounds the range. The
-- ids are collected first, so the delete finds them by primary key.
WITH due AS (
    SELECT c.id AS channel_id, t.before,
           (lpad(to_hex(floor(extract(epoch FROM t.before) * 1000)::bigint), 12, '0')
               || '70008000000000000000')::uuid AS before_id
    FROM channels c
    JOIN workspaces w ON w.id = c.workspace_id
    CROSS JOIN LATERAL (
        SELECT now() - make_interval(days => coalesce(c.retention_days, w.retention_days)) AS before
    ) t
    WHERE coalesce(c.retention_days, w.retention_days) IS NOT NULL
)
DELETE FROM messages WHERE id = ANY (ARRAY(
    SELECT m.id FROM due
    CROSS JOIN LATERAL (
        SELECT id, author_id, created_at FROM messages
        WHERE channel_id = due.channel_id AND id < due.before_id AND created_at < due.before
    ) m
    WHERE NOT message_held(due.channel_id, m.author_id, m.created_at) AND NOT thread_held(m.id)
    LIMIT @row_limit));

-- name: ListLegalHolds :many
SELECT * FROM legal_holds WHERE workspace_id = @workspace_id ORDER BY released_at NULLS FIRST, id DESC;

-- name: GetLegalHold :one
SELECT * FROM legal_holds WHERE id = @id;

-- name: CreateLegalHold :one
INSERT INTO legal_holds (workspace_id, name, description, user_ids, channel_ids, starts_at, ends_at, created_by)
VALUES (@workspace_id, @name, @description, @user_ids, @channel_ids, sqlc.narg(starts_at), sqlc.narg(ends_at), @created_by)
RETURNING *;

-- name: UpdateLegalHold :one
UPDATE legal_holds SET name = @name, description = @description, user_ids = @user_ids, channel_ids = @channel_ids,
    starts_at = sqlc.narg(starts_at), ends_at = sqlc.narg(ends_at)
WHERE id = @id AND released_at IS NULL
RETURNING *;

-- name: ReleaseLegalHold :one
UPDATE legal_holds SET released_at = now(), released_by = @user_id
WHERE id = @id AND released_at IS NULL
RETURNING *;

-- name: CountHeldMessages :one
SELECT count(*)::bigint FROM messages m JOIN channels c ON c.id = m.channel_id
WHERE c.workspace_id = @workspace_id
  AND (m.channel_id = ANY (@channel_ids::uuid[]) OR m.author_id = ANY (@user_ids::uuid[]))
  AND (sqlc.narg(starts_at)::timestamptz IS NULL OR m.created_at >= sqlc.narg(starts_at))
  AND (sqlc.narg(ends_at)::timestamptz IS NULL OR m.created_at < sqlc.narg(ends_at));

-- name: ListClassifications :many
SELECT * FROM classifications WHERE workspace_id = @workspace_id ORDER BY position, id;

-- name: ReplaceClassification :one
INSERT INTO classifications (id, workspace_id, name, description, color, position)
VALUES (@id, @workspace_id, @name, @description, @color, @position)
ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description,
    color = excluded.color, position = excluded.position
WHERE classifications.workspace_id = excluded.workspace_id
RETURNING *;

-- name: DeleteOtherClassifications :exec
DELETE FROM classifications WHERE workspace_id = @workspace_id AND NOT (id = ANY (@keep::uuid[]));

-- name: ListWorkspaceAttributes :many
SELECT * FROM workspace_attributes WHERE workspace_id = @workspace_id ORDER BY lower(name);

-- name: DeleteWorkspaceAttributes :exec
DELETE FROM workspace_attributes WHERE workspace_id = @workspace_id;

-- name: CreateWorkspaceAttribute :exec
INSERT INTO workspace_attributes (workspace_id, key, name) VALUES (@workspace_id, @key, @name);

-- name: SetMemberAttributes :exec
UPDATE workspace_members SET attributes = @attributes WHERE workspace_id = @workspace_id AND user_id = @user_id;

-- name: GetMemberAttributes :one
SELECT attributes FROM workspace_members WHERE workspace_id = @workspace_id AND user_id = @user_id;

-- name: ListMemberAttributes :many
SELECT user_id, attributes FROM workspace_members WHERE workspace_id = @workspace_id;

-- name: ExportMessages :many
-- ExportMessages returns a page of messages for eDiscovery, deleted ones
-- included, oldest first.
SELECT m.id, m.channel_id, c.name AS channel_name, m.author_id, coalesce(u.display_name, '') AS author_name,
    m.body, m.root_id, m.created_at, m.edited_at, m.deleted_at, m.has_files,
    message_held(m.channel_id, m.author_id, m.created_at) AS held
FROM messages m
JOIN channels c ON c.id = m.channel_id
LEFT JOIN users u ON u.id = m.author_id
WHERE c.workspace_id = @workspace_id
  AND (cardinality(@channel_ids::uuid[]) = 0 OR m.channel_id = ANY (@channel_ids::uuid[]))
  AND (cardinality(@user_ids::uuid[]) = 0 OR m.author_id = ANY (@user_ids::uuid[]))
  AND (sqlc.narg(since)::timestamptz IS NULL OR m.created_at >= sqlc.narg(since))
  AND (sqlc.narg(until)::timestamptz IS NULL OR m.created_at < sqlc.narg(until))
  AND (@query::text = '' OR cenacle_search_vector(m.body) @@ cenacle_search_query(@query::text))
  AND (sqlc.narg(after)::uuid IS NULL OR m.id > sqlc.narg(after))
ORDER BY m.id
LIMIT @row_limit;

-- name: ListChannelMemberAttributes :many
SELECT cm.user_id, wm.attributes FROM channel_members cm
JOIN channels c ON c.id = cm.channel_id
JOIN workspace_members wm ON wm.workspace_id = c.workspace_id AND wm.user_id = cm.user_id
WHERE cm.channel_id = @channel_id;

-- name: ListRuledChannelsOfMember :many
-- ListRuledChannelsOfMember returns a member's channels of a workspace that have access rules.
SELECT c.* FROM channels c JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = @user_id
WHERE c.workspace_id = @workspace_id AND c.access_rules <> '[]'::jsonb;

-- name: GetClassification :one
SELECT * FROM classifications WHERE id = @id;

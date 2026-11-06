-- name: InsertAuditEvent :exec
INSERT INTO audit_events (actor_id, workspace_id, action, target_type, target_id, ip_address, detail)
VALUES (@actor_id, @workspace_id, @action, @target_type, @target_id, @ip_address, @detail);

-- name: ListWorkspaceAudit :many
-- ListWorkspaceAudit returns a workspace's events newest first, before a cursor,
-- without the hidden actions (those the reader may not see).
SELECT e.*, coalesce(u.display_name, '')::text AS actor_name
FROM audit_events e
LEFT JOIN users u ON u.id = e.actor_id
WHERE e.workspace_id = @workspace_id
  AND (sqlc.narg(before)::uuid IS NULL OR e.id < sqlc.narg(before)::uuid)
  AND (@action_prefix::text = '' OR starts_with(e.action, @action_prefix::text))
  AND NOT (e.action = ANY(@hidden_actions::text[]))
ORDER BY e.id DESC
LIMIT @row_limit;

-- name: ListInstanceAudit :many
-- ListInstanceAudit returns the installation's events newest first, before a
-- cursor, filtered by action prefix, actor, workspace and time.
SELECT e.*, coalesce(u.display_name, '')::text AS actor_name, coalesce(w.name, '')::text AS workspace_name
FROM audit_events e
LEFT JOIN users u ON u.id = e.actor_id
LEFT JOIN workspaces w ON w.id = e.workspace_id
WHERE (sqlc.narg(before)::uuid IS NULL OR e.id < sqlc.narg(before)::uuid)
  AND (@action_prefix::text = '' OR starts_with(e.action, @action_prefix::text))
  AND (sqlc.narg(actor_id)::uuid IS NULL OR e.actor_id = sqlc.narg(actor_id)::uuid)
  AND (sqlc.narg(workspace_id)::uuid IS NULL OR e.workspace_id = sqlc.narg(workspace_id)::uuid)
  AND (sqlc.narg(since)::timestamptz IS NULL OR e.at >= sqlc.narg(since)::timestamptz)
  AND (sqlc.narg(until)::timestamptz IS NULL OR e.at < sqlc.narg(until)::timestamptz)
ORDER BY e.id DESC
LIMIT @row_limit;

-- name: AuditEventsAfter :many
-- AuditEventsAfter returns events after a cursor, oldest first (streaming).
SELECT e.*, coalesce(u.display_name, '')::text AS actor_name, coalesce(w.name, '')::text AS workspace_name
FROM audit_events e
LEFT JOIN users u ON u.id = e.actor_id
LEFT JOIN workspaces w ON w.id = e.workspace_id
WHERE e.id > @after::uuid
ORDER BY e.id
LIMIT @row_limit;

-- name: LatestAuditEventID :one
SELECT coalesce((SELECT id FROM audit_events ORDER BY id DESC LIMIT 1), '00000000-0000-0000-0000-000000000000'::uuid)::uuid;

-- name: GetAuditStream :one
SELECT audit_stream_kind, audit_stream_address, audit_stream_secret, audit_stream_tls, audit_stream_cursor,
       audit_stream_error, audit_stream_sent_at
FROM instance_settings;

-- name: SetAuditStream :exec
UPDATE instance_settings SET audit_stream_kind = @kind, audit_stream_address = @address,
    audit_stream_secret = @secret, audit_stream_tls = @tls, audit_stream_cursor = sqlc.narg(cursor),
    audit_stream_error = '', updated_at = now();

-- name: SetAuditStreamProgress :exec
UPDATE instance_settings SET audit_stream_cursor = @cursor, audit_stream_error = @error,
    audit_stream_sent_at = CASE WHEN @error::text = '' THEN now() ELSE audit_stream_sent_at END;

-- name: PruneAuditEvents :execrows
-- PruneAuditEvents deletes up to row_limit audit events from before the cut-off
-- (CENACLE_AUDIT_RETENTION), never ones a running audit stream has not sent yet.
-- Event ids are UUIDv7 made from their time, so the oldest id of the cut-off's
-- millisecond bounds the walk along the primary key.
DELETE FROM audit_events WHERE id IN (
    SELECT e.id FROM audit_events e
    WHERE e.id < (lpad(to_hex(floor(extract(epoch FROM @before::timestamptz) * 1000)::bigint), 12, '0')
                  || '70008000000000000000')::uuid
      AND e.at < @before::timestamptz
      AND NOT EXISTS (SELECT 1 FROM instance_settings s
                      WHERE s.audit_stream_kind <> 'none'
                        AND (s.audit_stream_cursor IS NULL OR e.id > s.audit_stream_cursor))
    ORDER BY e.id
    LIMIT @row_limit
);

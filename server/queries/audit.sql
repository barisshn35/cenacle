-- name: InsertAuditEvent :exec
INSERT INTO audit_events (actor_id, workspace_id, action, target_type, target_id, ip_address, detail)
VALUES (@actor_id, @workspace_id, @action, @target_type, @target_id, @ip_address, @detail);

-- name: ListWorkspaceAudit :many
-- ListWorkspaceAudit returns a workspace's events newest first, before a cursor.
SELECT e.*, coalesce(u.display_name, '')::text AS actor_name
FROM audit_events e
LEFT JOIN users u ON u.id = e.actor_id
WHERE e.workspace_id = @workspace_id
  AND (sqlc.narg(before)::uuid IS NULL OR e.id < sqlc.narg(before)::uuid)
ORDER BY e.id DESC
LIMIT @row_limit;

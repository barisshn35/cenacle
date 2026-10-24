-- name: ListUserWorkspaces :many
-- ListUserWorkspaces returns a user's workspaces with their role, the default
-- workspace first.
SELECT sqlc.embed(w), wm.role, wm.timeout_until, wm.onboarded_at
FROM workspaces w
JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = @user_id
ORDER BY w.is_default DESC, lower(w.name), w.id;

-- name: GetWorkspace :one
SELECT * FROM workspaces WHERE id = @id;

-- name: GetDefaultWorkspace :one
SELECT * FROM workspaces WHERE is_default;

-- name: CreateWorkspace :one
INSERT INTO workspaces (name, is_default) VALUES (@name, @is_default) RETURNING *;

-- name: RenameWorkspace :one
UPDATE workspaces SET name = coalesce(sqlc.narg(name), name),
    description = coalesce(sqlc.narg(description), description),
    edit_history = coalesce(sqlc.narg(edit_history), edit_history),
    persistent_notifications = coalesce(sqlc.narg(persistent_notifications), persistent_notifications),
    persistent_every_minutes = coalesce(sqlc.narg(persistent_every_minutes), persistent_every_minutes),
    persistent_times = coalesce(sqlc.narg(persistent_times), persistent_times),
    read_receipts = coalesce(sqlc.narg(read_receipts), read_receipts)
WHERE id = @id RETURNING *;

-- name: GetWorkspaceRole :one
-- GetWorkspaceRole returns the user's role in a workspace ('' when not a member).
SELECT coalesce((
    SELECT role FROM workspace_members WHERE workspace_id = @workspace_id AND user_id = @user_id
), '')::text;

-- name: AddWorkspaceMember :execrows
INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (@workspace_id, @user_id, @role)
ON CONFLICT DO NOTHING;

-- name: SetWorkspaceRole :execrows
UPDATE workspace_members SET role = @role WHERE workspace_id = @workspace_id AND user_id = @user_id;

-- name: LeaveWorkspaceChannels :execrows
-- LeaveWorkspaceChannels takes a user out of every channel of a workspace.
DELETE FROM channel_members m
USING channels c
WHERE c.id = m.channel_id AND c.workspace_id = @workspace_id AND m.user_id = @user_id;

-- name: RemoveWorkspaceMember :execrows
DELETE FROM workspace_members WHERE workspace_id = @workspace_id AND user_id = @user_id;

-- name: ListWorkspaceMembers :many
SELECT u.id, u.display_name, u.email, u.is_bot, wm.role, wm.joined_at
FROM workspace_members wm
JOIN users u ON u.id = wm.user_id
WHERE wm.workspace_id = @workspace_id
ORDER BY CASE wm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, lower(u.display_name), u.id;

-- name: CountWorkspaceOwners :one
SELECT count(*) FROM workspace_members WHERE workspace_id = @workspace_id AND role = 'owner';

-- name: JoinDefaultWorkspace :many
-- JoinDefaultWorkspace makes a user a member of the default workspace; it
-- returns the workspace when the user was not a member yet.
INSERT INTO workspace_members (workspace_id, user_id)
SELECT id, @user_id FROM workspaces WHERE is_default
ON CONFLICT DO NOTHING
RETURNING workspace_id;

-- name: AddAllUsersToWorkspace :execrows
INSERT INTO workspace_members (workspace_id, user_id)
SELECT @workspace_id, id FROM users WHERE NOT is_bot -- bots belong to their workspace only
ON CONFLICT DO NOTHING;

-- name: CreateInvite :one
INSERT INTO workspace_invites (workspace_id, token_hash, created_by, expires_at, max_uses)
VALUES (@workspace_id, @token_hash, @created_by, @expires_at, sqlc.narg(max_uses))
RETURNING *;

-- name: ListInvites :many
-- ListInvites returns the invitations of a workspace that can still be used.
SELECT * FROM workspace_invites
WHERE workspace_id = @workspace_id AND revoked_at IS NULL AND expires_at > now()
  AND (max_uses IS NULL OR uses < max_uses)
ORDER BY created_at DESC;

-- name: GetInviteByHash :one
SELECT sqlc.embed(i), w.name AS workspace_name
FROM workspace_invites i
JOIN workspaces w ON w.id = i.workspace_id
WHERE i.token_hash = @token_hash;

-- name: UseInvite :one
-- UseInvite counts one use of a valid invitation; no row when it is not valid.
UPDATE workspace_invites SET uses = uses + 1
WHERE id = @id AND revoked_at IS NULL AND expires_at > now()
  AND (max_uses IS NULL OR uses < max_uses)
RETURNING *;

-- name: RevokeInvite :execrows
UPDATE workspace_invites SET revoked_at = now()
WHERE id = @id AND workspace_id = @workspace_id AND revoked_at IS NULL;

-- name: SetWorkspacePermissions :one
UPDATE workspaces SET permissions = @permissions WHERE id = @id RETURNING *;

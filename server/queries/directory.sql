-- name: SetDirectoryProfile :exec
UPDATE users SET username = sqlc.narg(username), directory_role = sqlc.narg(directory_role) WHERE id = @id;

-- name: ReplaceUserGroups :exec
-- ReplaceUserGroups sets the directory groups of a person.
WITH gone AS (DELETE FROM user_groups WHERE user_id = @user_id AND NOT (group_name = ANY(@names::text[])))
INSERT INTO user_groups (user_id, group_name)
SELECT @user_id, n FROM unnest(@names::text[]) AS n
ON CONFLICT DO NOTHING;

-- name: ListUserGroups :many
SELECT group_name FROM user_groups WHERE user_id = @user_id ORDER BY group_name;

-- name: ListKnownGroups :many
-- ListKnownGroups is every group name people of the instance are in.
SELECT DISTINCT group_name FROM user_groups ORDER BY group_name;

-- name: GetUserByAuth :one
SELECT * FROM users WHERE auth_service = @auth_service AND auth_data = @auth_data;

-- name: SetUserDeactivated :one
-- SetUserDeactivated deactivates or reactivates a person; it returns whether
-- the state changed.
UPDATE users SET deactivated_at = CASE WHEN @deactivated::boolean THEN coalesce(deactivated_at, now()) END
WHERE id = @id AND (deactivated_at IS NOT NULL) <> @deactivated::boolean
RETURNING id;

-- name: SetAdminByDirectory :exec
UPDATE users SET is_admin = @is_admin WHERE id = @id;

-- name: ListWorkspaceGroupMappings :many
SELECT * FROM workspace_group_mappings WHERE workspace_id = @workspace_id ORDER BY lower(group_name);

-- name: UpsertWorkspaceGroupMapping :one
INSERT INTO workspace_group_mappings (workspace_id, group_name, role) VALUES (@workspace_id, @group_name, @role)
ON CONFLICT (workspace_id, group_name) DO UPDATE SET role = EXCLUDED.role
RETURNING *;

-- name: DeleteWorkspaceGroupMapping :execrows
DELETE FROM workspace_group_mappings WHERE workspace_id = @workspace_id AND group_name = @group_name;

-- name: ListChannelGroupMappings :many
SELECT group_name FROM channel_group_mappings WHERE channel_id = @channel_id ORDER BY lower(group_name);

-- name: AddChannelGroupMapping :exec
INSERT INTO channel_group_mappings (channel_id, group_name) VALUES (@channel_id, @group_name) ON CONFLICT DO NOTHING;

-- name: DeleteChannelGroupMapping :execrows
DELETE FROM channel_group_mappings WHERE channel_id = @channel_id AND group_name = @group_name;

-- name: SetChannelGroupManaged :exec
UPDATE channels SET group_managed = @group_managed WHERE id = @id;

-- name: WorkspaceRolesFromGroups :many
-- WorkspaceRolesFromGroups is, per workspace, the strongest role a person's
-- groups give them there.
SELECT m.workspace_id,
       (array_agg(m.role ORDER BY CASE m.role WHEN 'admin' THEN 0 WHEN 'member' THEN 1 ELSE 2 END))[1]::text AS role
FROM workspace_group_mappings m
JOIN user_groups g ON lower(g.group_name) = lower(m.group_name)
WHERE g.user_id = @user_id
GROUP BY m.workspace_id;

-- name: JoinWorkspaceViaGroup :one
-- JoinWorkspaceViaGroup adds a person to a workspace for a group (or changes
-- the role a group gave). Memberships added by hand only ever gain a role;
-- owners stay owners. Returns whether the person is new there.
INSERT INTO workspace_members (workspace_id, user_id, role, via_group) VALUES (@workspace_id, @user_id, @role, true)
ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = CASE
    WHEN workspace_members.role = 'owner' THEN 'owner'
    WHEN workspace_members.via_group THEN EXCLUDED.role
    WHEN workspace_members.role = 'member' AND EXCLUDED.role = 'admin' THEN 'admin'
    ELSE workspace_members.role END
RETURNING (xmax = 0) AS joined;

-- name: LeaveWorkspacesViaGroup :many
-- LeaveWorkspacesViaGroup takes back group-given memberships no group gives
-- any more (and the person's channels there); it returns those workspaces.
WITH gone AS (
    DELETE FROM workspace_members wm
    WHERE wm.user_id = sqlc.arg(user_id)::uuid AND wm.via_group AND NOT (wm.workspace_id = ANY(sqlc.arg(kept)::uuid[]))
    RETURNING wm.workspace_id
), channels_gone AS (
    DELETE FROM channel_members cm USING channels c, gone
    WHERE cm.user_id = sqlc.arg(user_id)::uuid AND c.id = cm.channel_id AND c.workspace_id = gone.workspace_id
)
SELECT gone.workspace_id FROM gone;

-- name: ChannelsFromGroups :many
-- ChannelsFromGroups is the channels a person's groups give them, in the
-- workspaces they are a member of.
SELECT DISTINCT c.id
FROM channel_group_mappings m
JOIN user_groups g ON lower(g.group_name) = lower(m.group_name) AND g.user_id = @user_id
JOIN channels c ON c.id = m.channel_id AND c.archived_at IS NULL
JOIN workspace_members wm ON wm.workspace_id = c.workspace_id AND wm.user_id = @user_id;

-- name: JoinChannelViaGroup :execrows
INSERT INTO channel_members (channel_id, user_id, role, via_group) VALUES (@channel_id, @user_id, 'member', true)
ON CONFLICT DO NOTHING;

-- name: LeaveChannelsViaGroup :many
-- LeaveChannelsViaGroup takes the person out of channels their groups no
-- longer give: group-given memberships, and any membership of a channel
-- managed by groups.
DELETE FROM channel_members cm USING channels c
WHERE cm.user_id = @user_id AND c.id = cm.channel_id AND (cm.via_group OR c.group_managed)
  AND NOT (cm.channel_id = ANY(@kept::uuid[]))
RETURNING cm.channel_id;

-- name: UsersInGroup :many
SELECT DISTINCT u.* FROM users u JOIN user_groups g ON g.user_id = u.id
WHERE lower(g.group_name) = lower(@group_name) AND u.deactivated_at IS NULL;

-- name: GetDirectorySyncState :one
SELECT * FROM directory_sync_state WHERE id;

-- name: SaveDirectorySyncState :exec
INSERT INTO directory_sync_state (id, cursor, synced_at) VALUES (true, @cursor, now())
ON CONFLICT (id) DO UPDATE SET cursor = EXCLUDED.cursor, synced_at = now();

-- name: SetGuestRoles :exec
-- SetGuestRoles makes a person a guest wherever they are a member or an
-- administrator (or takes it back when they are not a guest any more).
UPDATE workspace_members SET role = CASE WHEN @guest::boolean THEN 'guest' ELSE 'member' END
WHERE user_id = @user_id AND (CASE WHEN @guest::boolean THEN role IN ('member', 'admin') ELSE role = 'guest' AND NOT via_group END);

-- name: UpdateUserProfile :exec
-- UpdateUserProfile follows a change of name or address at Cenacle ID.
UPDATE users SET email = @email, email_verified = @email_verified, display_name = @display_name,
    updated_at = CASE WHEN (email, email_verified, display_name) IS DISTINCT FROM (@email, @email_verified, @display_name)
        THEN now() ELSE updated_at END
WHERE id = @id;

-- name: PeopleSharingChannels :many
-- PeopleSharingChannels is everyone who is in a channel of the workspace with
-- the person (what a guest may see of a workspace).
SELECT DISTINCT other.user_id
FROM channel_members mine
JOIN channels c ON c.id = mine.channel_id AND c.workspace_id = @workspace_id
JOIN channel_members other ON other.channel_id = mine.channel_id
WHERE mine.user_id = @user_id;

-- name: ListChannelMemberIDs :many
SELECT user_id FROM channel_members WHERE channel_id = @channel_id;

-- name: LeaveDefaultChannelsAsGuest :many
-- LeaveDefaultChannelsAsGuest takes a guest out of the channels for everyone
-- of the workspaces they are a guest in.
DELETE FROM channel_members cm USING channels c, workspace_members wm
WHERE cm.user_id = @user_id AND c.id = cm.channel_id AND c.is_default
  AND wm.workspace_id = c.workspace_id AND wm.user_id = cm.user_id AND wm.role = 'guest'
RETURNING cm.channel_id;

-- name: RevokeEmailAdminsExcept :exec
-- RevokeEmailAdminsExcept takes the administrator flag from everyone who held
-- it only by the configured address, but one person (the address moved).
UPDATE users SET is_admin = false
WHERE is_admin AND id <> @id AND directory_role IS DISTINCT FROM 'admin';

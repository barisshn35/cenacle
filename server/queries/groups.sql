-- name: ListMentionGroups :many
-- ListMentionGroups returns a workspace's groups with how many people are in
-- each and whether the user is in it or manages it.
SELECT g.*,
       (SELECT count(*) FROM mention_group_people p WHERE p.group_id = g.id)::int AS member_count,
       EXISTS (SELECT 1 FROM mention_group_people p WHERE p.group_id = g.id AND p.user_id = @user_id) AS is_member,
       EXISTS (SELECT 1 FROM mention_group_members p WHERE p.group_id = g.id AND p.user_id = @user_id AND p.manager) AS is_manager
FROM mention_groups g
WHERE g.workspace_id = @workspace_id
ORDER BY g.archived_at IS NOT NULL, g.handle;

-- name: GetMentionGroup :one
SELECT * FROM mention_groups WHERE id = @id;

-- name: CreateMentionGroup :one
INSERT INTO mention_groups (workspace_id, handle, name, description, directory_group, created_by)
VALUES (@workspace_id, @handle, @name, @description, sqlc.narg(directory_group), @created_by)
RETURNING *;

-- name: UpdateMentionGroup :one
UPDATE mention_groups SET
    handle      = coalesce(sqlc.narg(handle), handle),
    name        = coalesce(sqlc.narg(name), name),
    description = coalesce(sqlc.narg(description), description),
    archived_at = CASE WHEN sqlc.narg(archived)::boolean IS NULL THEN archived_at
                       WHEN sqlc.narg(archived)::boolean THEN coalesce(archived_at, now())
                       ELSE NULL END
WHERE id = @id
RETURNING *;

-- name: AddMentionGroupMembers :exec
-- AddMentionGroupMembers adds people of the group's workspace to it.
INSERT INTO mention_group_members (group_id, user_id, manager)
SELECT @group_id, wm.user_id, @manager
FROM mention_groups g
JOIN workspace_members wm ON wm.workspace_id = g.workspace_id
JOIN users u ON u.id = wm.user_id AND NOT u.is_bot AND u.deactivated_at IS NULL
WHERE g.id = @group_id AND wm.user_id = ANY(@user_ids::uuid[])
ON CONFLICT (group_id, user_id) DO NOTHING;

-- name: RemoveMentionGroupMember :execrows
DELETE FROM mention_group_members WHERE group_id = @group_id AND user_id = @user_id;

-- name: SetMentionGroupManager :execrows
UPDATE mention_group_members SET manager = @manager WHERE group_id = @group_id AND user_id = @user_id;

-- name: CountMentionGroupManagers :one
SELECT count(*)::int FROM mention_group_members WHERE group_id = @group_id AND manager;

-- name: ListMentionGroupPeople :many
SELECT u.id, u.display_name, u.email, u.is_bot, p.manager
FROM mention_group_people p JOIN users u ON u.id = p.user_id
WHERE p.group_id = @group_id AND u.deactivated_at IS NULL
ORDER BY p.manager DESC, lower(u.display_name);

-- name: AddGroupMentions :exec
-- AddGroupMentions records a mention for each person of the mentioned groups
-- (by handle, not archived) who is in the channel, but the author.
INSERT INTO message_mentions (message_id, user_id, kind)
SELECT DISTINCT @message_id::uuid, p.user_id, 'group'
FROM mention_groups g
JOIN mention_group_people p ON p.group_id = g.id
JOIN channel_members m ON m.channel_id = @channel_id AND m.user_id = p.user_id
JOIN users u ON u.id = p.user_id AND NOT u.is_bot
WHERE g.workspace_id = @workspace_id AND g.archived_at IS NULL AND g.handle = ANY(@handles::text[])
  AND p.user_id <> @author_id
ON CONFLICT DO NOTHING;

-- name: GetGroupCreation :one
SELECT group_creation FROM workspaces WHERE id = @id;

-- name: SetGroupCreation :exec
UPDATE workspaces SET group_creation = @group_creation WHERE id = @id;

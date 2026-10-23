-- name: GetSidebarLayout :one
SELECT layout FROM sidebar_layouts WHERE user_id = @user_id AND workspace_id = @workspace_id;

-- name: PutSidebarLayout :exec
INSERT INTO sidebar_layouts (user_id, workspace_id, layout)
VALUES (@user_id, @workspace_id, @layout)
ON CONFLICT (user_id, workspace_id) DO UPDATE SET layout = EXCLUDED.layout, updated_at = now();

-- name: ListWorkspaceMemberChannels :many
-- ListWorkspaceMemberChannels returns the channels and conversations of a workspace
-- the user belongs to.
SELECT c.id FROM channels c
JOIN channel_members m ON m.channel_id = c.id AND m.user_id = @user_id
WHERE c.workspace_id = @workspace_id;

-- name: ListCategoryIDs :many
SELECT id FROM channel_categories WHERE workspace_id = @workspace_id;

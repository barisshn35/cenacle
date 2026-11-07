-- name: ListChannelTabs :many
SELECT * FROM channel_tabs WHERE channel_id = @channel_id ORDER BY position, id;

-- name: GetChannelTab :one
SELECT * FROM channel_tabs WHERE id = @id;

-- name: GetTabByCanvas :one
SELECT * FROM channel_tabs WHERE canvas_id = @canvas_id;

-- name: GetTabByList :one
SELECT * FROM channel_tabs WHERE list_id = @list_id;

-- name: CountChannelTabs :one
SELECT count(*)::int FROM channel_tabs WHERE channel_id = @channel_id;

-- name: CreateChannelTab :one
INSERT INTO channel_tabs (channel_id, kind, title, url, canvas_id, list_id, position, created_by)
VALUES (@channel_id, @kind, @title, sqlc.narg(url), sqlc.narg(canvas_id), sqlc.narg(list_id),
        (SELECT coalesce(max(position), -1) + 1 FROM channel_tabs WHERE channel_id = @channel_id),
        @created_by)
RETURNING *;

-- name: RenameChannelTab :one
UPDATE channel_tabs SET title = @title, url = coalesce(sqlc.narg(url), url)
WHERE id = @id
RETURNING *;

-- name: SetChannelTabPosition :exec
UPDATE channel_tabs SET position = @position WHERE id = @id;

-- name: DeleteChannelTab :exec
DELETE FROM channel_tabs WHERE id = @id;

-- name: CreateCanvas :one
INSERT INTO canvases (channel_id, body, updated_by) VALUES (@channel_id, @body, @updated_by)
RETURNING *;

-- name: GetCanvas :one
SELECT c.*, coalesce(u.display_name, '') AS updated_by_name, coalesce(e.display_name, '') AS editing_by_name
FROM canvases c
LEFT JOIN users u ON u.id = c.updated_by
LEFT JOIN users e ON e.id = c.editing_by AND c.editing_until > now()
WHERE c.id = @id;

-- name: SaveCanvas :one
-- SaveCanvas writes a new body over the version it was edited from, and ends
-- the writer's turn; no row means the canvas changed in between.
UPDATE canvases SET body = @body, version = version + 1, updated_by = @user_id, updated_at = now(),
    editing_by = NULL, editing_until = NULL
WHERE id = @id AND version = @version
RETURNING id;

-- name: TakeCanvasTurn :one
-- TakeCanvasTurn gives the user the turn to edit when nobody else holds it;
-- no row means someone else is editing.
UPDATE canvases SET editing_by = @user_id, editing_until = now() + make_interval(secs => @seconds::int)
WHERE id = @id AND (editing_by IS NULL OR editing_by = @user_id OR editing_until <= now())
RETURNING id;

-- name: EndCanvasTurn :one
UPDATE canvases SET editing_by = NULL, editing_until = NULL
WHERE id = @id AND editing_by = @user_id
RETURNING id;

-- name: DeleteCanvas :exec
DELETE FROM canvases WHERE id = @id;

-- name: CreateList :one
INSERT INTO lists (channel_id, columns, board_column) VALUES (@channel_id, @columns, sqlc.narg(board_column))
RETURNING *;

-- name: GetList :one
SELECT * FROM lists WHERE id = @id;

-- name: UpdateList :one
UPDATE lists SET columns = @columns, board_column = sqlc.narg(board_column), updated_at = now()
WHERE id = @id
RETURNING *;

-- name: DeleteList :exec
DELETE FROM lists WHERE id = @id;

-- name: ListListItems :many
SELECT * FROM list_items WHERE list_id = @list_id ORDER BY position, id;

-- name: CountListItems :one
SELECT count(*)::int FROM list_items WHERE list_id = @list_id;

-- name: GetListItem :one
SELECT * FROM list_items WHERE id = @id;

-- name: CreateListItem :one
INSERT INTO list_items (list_id, title, "values", position, assignees, done, due, created_by)
VALUES (@list_id, @title, @values, (SELECT coalesce(max(position), 0) + 1 FROM list_items WHERE list_id = @list_id),
        @assignees, @done, sqlc.narg(due), @created_by)
RETURNING *;

-- name: UpdateListItem :one
UPDATE list_items SET title = @title, "values" = @values, position = @position, assignees = @assignees,
    done = @done, due = sqlc.narg(due), updated_at = now(),
    updated_by = coalesce(sqlc.narg(updated_by), updated_by)
WHERE id = @id
RETURNING *;

-- name: DeleteListItem :exec
DELETE FROM list_items WHERE id = @id;

-- name: ListAssignedItems :many
-- ListAssignedItems returns the open list rows assigned to a person in the
-- channels of a workspace they belong to, the soonest due first.
SELECT i.*, t.id AS tab_id, t.title AS list_title, ch.id AS channel_id, ch.name AS channel_name
FROM list_items i
JOIN channel_tabs t ON t.list_id = i.list_id
JOIN channels ch ON ch.id = t.channel_id
JOIN channel_members m ON m.channel_id = ch.id AND m.user_id = @user_id
WHERE ch.workspace_id = @workspace_id AND ch.archived_at IS NULL
  AND NOT i.done AND i.assignees @> ARRAY[@user_id::uuid]
ORDER BY i.due NULLS LAST, i.id
LIMIT 200;

-- name: SetListItemPosition :exec
UPDATE list_items SET position = @position WHERE id = @id;

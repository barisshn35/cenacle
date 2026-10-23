-- +goose Up
-- Each person's own arrangement of a workspace's sidebar (v0.31): Favorites,
-- sections they create, which channels and conversations go where, the order
-- of the sections, which are folded away, and whether unread ones gather at
-- the top. One document per person and workspace, written as a whole.
CREATE TABLE sidebar_layouts (
    user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    workspace_id uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    layout       jsonb       NOT NULL,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, workspace_id)
);

-- +goose Down
DROP TABLE sidebar_layouts;

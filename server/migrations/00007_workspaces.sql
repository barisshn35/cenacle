-- SPDX-License-Identifier: Apache-2.0
--
-- Workspaces with roles, and invitations. Everything that existed moves to
-- the default workspace, which every user belongs to.

-- +goose Up
CREATE TABLE workspaces (
    id         uuid        PRIMARY KEY DEFAULT uuidv7(),
    name       text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80 AND name = btrim(name)),
    -- Everyone who signs in joins the default workspace.
    is_default boolean     NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX workspaces_single_default_idx ON workspaces (is_default) WHERE is_default;

CREATE TABLE workspace_members (
    workspace_id uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role         text        NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
    joined_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user_id_idx ON workspace_members (user_id);

INSERT INTO workspaces (name, is_default) VALUES ('Cenacle', true);
INSERT INTO workspace_members (workspace_id, user_id, role)
SELECT w.id, u.id, CASE WHEN u.is_admin THEN 'owner' ELSE 'member' END
FROM workspaces w CROSS JOIN users u;

-- Channels and categories belong to a workspace; names are unique within it.
ALTER TABLE channels ADD COLUMN workspace_id uuid REFERENCES workspaces (id) ON DELETE CASCADE;
UPDATE channels SET workspace_id = (SELECT id FROM workspaces WHERE is_default);
ALTER TABLE channels ALTER COLUMN workspace_id SET NOT NULL;
DROP INDEX channels_name_lower_idx;
CREATE UNIQUE INDEX channels_workspace_name_idx ON channels (workspace_id, lower(name));

ALTER TABLE channel_categories ADD COLUMN workspace_id uuid REFERENCES workspaces (id) ON DELETE CASCADE;
UPDATE channel_categories SET workspace_id = (SELECT id FROM workspaces WHERE is_default);
ALTER TABLE channel_categories ALTER COLUMN workspace_id SET NOT NULL;
DROP INDEX channel_categories_name_lower_idx;
CREATE UNIQUE INDEX channel_categories_workspace_name_idx ON channel_categories (workspace_id, lower(name));

CREATE TABLE workspace_invites (
    id           uuid        PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    -- SHA-256 of the invitation token; the token is only shown when created.
    token_hash   bytea       NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    created_by   uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    max_uses     integer     CHECK (max_uses IS NULL OR max_uses > 0),
    uses         integer     NOT NULL DEFAULT 0,
    revoked_at   timestamptz
);
CREATE INDEX workspace_invites_workspace_id_idx ON workspace_invites (workspace_id);

-- +goose Down
DROP TABLE workspace_invites;
DROP INDEX channel_categories_workspace_name_idx;
ALTER TABLE channel_categories DROP COLUMN workspace_id;
CREATE UNIQUE INDEX channel_categories_name_lower_idx ON channel_categories (lower(name));
DROP INDEX channels_workspace_name_idx;
ALTER TABLE channels DROP COLUMN workspace_id;
CREATE UNIQUE INDEX channels_name_lower_idx ON channels (lower(name));
DROP TABLE workspace_members;
DROP TABLE workspaces;

-- +goose Up
-- Several instance administrators: the configured address and the directory's
-- administrators.
DROP INDEX users_single_admin_idx;

-- What Cenacle ID says about people from a directory (LDAP / Active Directory):
-- sign-in name, role (admin / guest from the directory's filters) and groups.
ALTER TABLE users
    ADD COLUMN username       text,
    ADD COLUMN directory_role text CHECK (directory_role IN ('admin', 'guest')),
    -- Deactivated at Cenacle ID (left the directory, disabled): no sign-in,
    -- sessions ended; messages stay.
    ADD COLUMN deactivated_at timestamptz;

CREATE TABLE user_groups (
    user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    group_name text NOT NULL,
    PRIMARY KEY (user_id, group_name)
);
CREATE INDEX user_groups_group_idx ON user_groups (lower(group_name));

-- Guests: only the channels they are added to, and the people in them.
ALTER TABLE workspace_members DROP CONSTRAINT workspace_members_role_check;
ALTER TABLE workspace_members ADD CONSTRAINT workspace_members_role_check
    CHECK (role IN ('owner', 'admin', 'member', 'guest'));
-- Memberships a group mapping gave are taken back when the person leaves the group.
ALTER TABLE workspace_members ADD COLUMN via_group boolean NOT NULL DEFAULT false;
ALTER TABLE channel_members ADD COLUMN via_group boolean NOT NULL DEFAULT false;

-- Members of a directory group join a workspace (with a role).
CREATE TABLE workspace_group_mappings (
    workspace_id uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    group_name   text        NOT NULL CHECK (char_length(group_name) BETWEEN 1 AND 200),
    role         text        NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member', 'guest')),
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, group_name)
);
-- Members of a directory group join a channel; a channel managed by groups has
-- exactly the members of its groups (people cannot be added or leave by hand).
CREATE TABLE channel_group_mappings (
    channel_id uuid        NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    group_name text        NOT NULL CHECK (char_length(group_name) BETWEEN 1 AND 200),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, group_name)
);
ALTER TABLE channels ADD COLUMN group_managed boolean NOT NULL DEFAULT false;

-- Where the synchronization with Cenacle ID's directory feed stands.
CREATE TABLE directory_sync_state (
    id         boolean     PRIMARY KEY DEFAULT true CHECK (id),
    cursor     text        NOT NULL DEFAULT '',
    synced_at  timestamptz
);

-- +goose Down
DROP TABLE directory_sync_state;
ALTER TABLE channels DROP COLUMN group_managed;
DROP TABLE channel_group_mappings;
DROP TABLE workspace_group_mappings;
ALTER TABLE channel_members DROP COLUMN via_group;
ALTER TABLE workspace_members DROP COLUMN via_group;
DELETE FROM workspace_members WHERE role = 'guest';
ALTER TABLE workspace_members DROP CONSTRAINT workspace_members_role_check;
ALTER TABLE workspace_members ADD CONSTRAINT workspace_members_role_check
    CHECK (role IN ('owner', 'admin', 'member'));
DROP TABLE user_groups;
ALTER TABLE users DROP COLUMN deactivated_at, DROP COLUMN directory_role, DROP COLUMN username;
UPDATE users SET is_admin = false
WHERE is_admin AND id <> (SELECT id FROM users WHERE is_admin ORDER BY created_at LIMIT 1);
CREATE UNIQUE INDEX users_single_admin_idx ON users (is_admin) WHERE is_admin;

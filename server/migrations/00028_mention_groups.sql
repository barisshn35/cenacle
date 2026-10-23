-- +goose Up
-- Groups people mention together (v0.31): "@backend" reaches the group's
-- members who are in the channel, like a mention of each. People of a
-- workspace create groups and manage the ones they manage; a group can also
-- follow a directory group, whose members it then has (set by administrators).
CREATE TABLE mention_groups (
    id              uuid        PRIMARY KEY DEFAULT uuidv7(),
    workspace_id    uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    handle          text        NOT NULL CHECK (handle ~ '^[a-z0-9]([a-z0-9._-]{0,28}[a-z0-9])?$'),
    name            text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
    description     text        NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
    directory_group text        CHECK (char_length(directory_group) BETWEEN 1 AND 200),
    created_by      uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    archived_at     timestamptz
);
CREATE UNIQUE INDEX mention_groups_handle_idx ON mention_groups (workspace_id, handle);

CREATE TABLE mention_group_members (
    group_id uuid        NOT NULL REFERENCES mention_groups (id) ON DELETE CASCADE,
    user_id  uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    manager  boolean     NOT NULL DEFAULT false,
    added_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, user_id)
);
CREATE INDEX mention_group_members_user_idx ON mention_group_members (user_id);

-- Who is in a group: its own members, or the workspace's people in its
-- directory group.
CREATE VIEW mention_group_people AS
SELECT m.group_id, m.user_id, m.manager
FROM mention_group_members m
UNION ALL
SELECT g.id, ug.user_id, false
FROM mention_groups g
JOIN user_groups ug ON lower(ug.group_name) = lower(g.directory_group)
JOIN workspace_members wm ON wm.workspace_id = g.workspace_id AND wm.user_id = ug.user_id
WHERE g.directory_group IS NOT NULL;

-- Who may create groups in a workspace: its members, or only administrators.
ALTER TABLE workspaces
    ADD COLUMN group_creation text NOT NULL DEFAULT 'members' CHECK (group_creation IN ('members', 'admins'));

-- A group mention is recorded for each person it reaches.
ALTER TABLE message_mentions DROP CONSTRAINT message_mentions_kind_check;
ALTER TABLE message_mentions ADD CONSTRAINT message_mentions_kind_check
    CHECK (kind IN ('person', 'channel', 'here', 'role', 'group'));

-- +goose Down
DELETE FROM message_mentions WHERE kind = 'group';
ALTER TABLE message_mentions DROP CONSTRAINT message_mentions_kind_check;
ALTER TABLE message_mentions ADD CONSTRAINT message_mentions_kind_check
    CHECK (kind IN ('person', 'channel', 'here', 'role'));
ALTER TABLE workspaces DROP COLUMN group_creation;
DROP VIEW mention_group_people;
DROP TABLE mention_group_members;
DROP TABLE mention_groups;

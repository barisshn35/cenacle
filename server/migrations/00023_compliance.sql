-- +goose Up
-- Compliance and access: how long messages are kept, legal holds that keep
-- them anyway, classification banners, member attributes that channels can
-- require, and channels encrypted end to end.

-- Retention: days to keep messages (NULL: forever). A channel's own setting
-- wins over its workspace's.
ALTER TABLE workspaces ADD COLUMN retention_days integer CHECK (retention_days BETWEEN 1 AND 36500);
ALTER TABLE channels ADD COLUMN retention_days integer CHECK (retention_days BETWEEN 1 AND 36500);

-- A legal hold keeps the messages of some people and/or channels of a
-- workspace, written in a period, from every kind of deletion.
CREATE TABLE legal_holds (
    id           uuid        PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    name         text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
    description  text        NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
    user_ids     uuid[]      NOT NULL DEFAULT '{}',
    channel_ids  uuid[]      NOT NULL DEFAULT '{}',
    starts_at    timestamptz,
    ends_at      timestamptz,
    created_by   uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    released_at  timestamptz,
    released_by  uuid        REFERENCES users (id) ON DELETE SET NULL,
    CHECK (cardinality(user_ids) + cardinality(channel_ids) > 0)
);
CREATE INDEX legal_holds_active_idx ON legal_holds (workspace_id) WHERE released_at IS NULL;

-- message_held: whether an active hold covers a message.
CREATE FUNCTION message_held(channel uuid, author uuid, written timestamptz) RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM legal_holds h JOIN channels c ON c.id = channel AND c.workspace_id = h.workspace_id
        WHERE h.released_at IS NULL
          AND (channel = ANY (h.channel_ids) OR author = ANY (h.user_ids))
          AND (h.starts_at IS NULL OR written >= h.starts_at)
          AND (h.ends_at IS NULL OR written < h.ends_at))
$$;

-- Classifications: banners that say how a channel's content is to be handled.
CREATE TABLE classifications (
    id           uuid        PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    name         text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
    description  text        NOT NULL DEFAULT '' CHECK (char_length(description) <= 300),
    color        text        NOT NULL CHECK (color IN ('neutral', 'info', 'success', 'warning', 'danger')),
    position     integer     NOT NULL DEFAULT 0
);
CREATE INDEX classifications_workspace_idx ON classifications (workspace_id, position);
ALTER TABLE workspaces ADD COLUMN classification_id uuid REFERENCES classifications (id) ON DELETE SET NULL;
ALTER TABLE channels ADD COLUMN classification_id uuid REFERENCES classifications (id) ON DELETE SET NULL;

-- Attributes of members (e.g. department, location) that channels can require.
CREATE TABLE workspace_attributes (
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    key          text NOT NULL CHECK (key ~ '^[a-z0-9_]{1,32}$'),
    name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
    PRIMARY KEY (workspace_id, key)
);
ALTER TABLE workspace_members ADD COLUMN attributes jsonb NOT NULL DEFAULT '{}';
-- [{"key", "values": [...]}]: a member needs one of the values of every rule.
ALTER TABLE channels ADD COLUMN access_rules jsonb NOT NULL DEFAULT '[]';

-- End-to-end encrypted channels: bodies are envelopes ("e2e:v1:…") the server
-- cannot read; key_check lets members confirm they share the passphrase.
ALTER TABLE channels ADD COLUMN encrypted boolean NOT NULL DEFAULT false;
ALTER TABLE channels ADD COLUMN key_check text NOT NULL DEFAULT '' CHECK (char_length(key_check) <= 400);
ALTER TABLE messages DROP CONSTRAINT messages_body_check;
ALTER TABLE messages ADD CONSTRAINT messages_body_check
    CHECK ((char_length(body) <= 4000 OR (body LIKE 'e2e:v1:%' AND char_length(body) <= 12000))
           AND (body <> '' OR attachments <> '[]'::jsonb OR has_files OR sticker_id IS NOT NULL
                OR task_id IS NOT NULL OR submission_id IS NOT NULL));

-- +goose Down
DELETE FROM messages WHERE char_length(body) > 4000;
ALTER TABLE messages DROP CONSTRAINT messages_body_check;
ALTER TABLE messages ADD CONSTRAINT messages_body_check
    CHECK (char_length(body) <= 4000 AND (body <> '' OR attachments <> '[]'::jsonb OR has_files
           OR sticker_id IS NOT NULL OR task_id IS NOT NULL OR submission_id IS NOT NULL));
ALTER TABLE channels DROP COLUMN key_check, DROP COLUMN encrypted, DROP COLUMN access_rules,
    DROP COLUMN classification_id, DROP COLUMN retention_days;
ALTER TABLE workspace_members DROP COLUMN attributes;
DROP TABLE workspace_attributes;
ALTER TABLE workspaces DROP COLUMN classification_id, DROP COLUMN retention_days;
DROP TABLE classifications;
DROP FUNCTION message_held(uuid, uuid, timestamptz);
DROP TABLE legal_holds;

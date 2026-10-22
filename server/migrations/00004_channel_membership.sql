-- SPDX-License-Identifier: AGPL-3.0-only
--
-- Channel membership, default and announcement channels, and the one user
-- who may create channels until roles arrive (v0.6).

-- +goose Up
-- Channel names are display names ("Central", "Release notes"), unique
-- regardless of case, without surrounding spaces.
ALTER TABLE channels DROP CONSTRAINT channels_name_check, DROP CONSTRAINT channels_name_key;
ALTER TABLE channels ADD CONSTRAINT channels_name_check
    CHECK (char_length(name) BETWEEN 1 AND 80 AND name = btrim(name) AND name !~ '[[:cntrl:]]');
CREATE UNIQUE INDEX channels_name_lower_idx ON channels (lower(name));
UPDATE channels SET name = 'General' WHERE name = 'general';

ALTER TABLE users ADD COLUMN is_admin boolean NOT NULL DEFAULT false;
-- At most one administrator.
CREATE UNIQUE INDEX users_single_admin_idx ON users (is_admin) WHERE is_admin;

ALTER TABLE channels
    -- announcement: everyone reads, only the administrator writes.
    ADD COLUMN kind text NOT NULL DEFAULT 'standard' CHECK (kind IN ('standard', 'announcement')),
    -- Default channels have every user as a member.
    ADD COLUMN is_default boolean NOT NULL DEFAULT false,
    -- Mandatory channels cannot be left.
    ADD COLUMN is_mandatory boolean NOT NULL DEFAULT false,
    ADD COLUMN created_by uuid REFERENCES users (id) ON DELETE SET NULL,
    ADD CONSTRAINT channels_mandatory_is_default CHECK (NOT is_mandatory OR is_default);

UPDATE channels SET is_default = true WHERE name = 'General';

CREATE TABLE channel_members (
    channel_id uuid        NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    joined_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, user_id)
);

CREATE INDEX channel_members_user_id_idx ON channel_members (user_id);

INSERT INTO channel_members (channel_id, user_id)
SELECT c.id, u.id FROM channels c CROSS JOIN users u WHERE c.is_default;

-- +goose Down
DROP TABLE channel_members;
ALTER TABLE channels
    DROP CONSTRAINT channels_mandatory_is_default,
    DROP COLUMN created_by,
    DROP COLUMN is_mandatory,
    DROP COLUMN is_default,
    DROP COLUMN kind;
DROP INDEX users_single_admin_idx;
ALTER TABLE users DROP COLUMN is_admin;
UPDATE channels SET name = lower(regexp_replace(name, '[^A-Za-z0-9_-]+', '-', 'g'));
DROP INDEX channels_name_lower_idx;
ALTER TABLE channels DROP CONSTRAINT channels_name_check;
ALTER TABLE channels ADD CONSTRAINT channels_name_check CHECK (name ~ '^[a-z0-9][a-z0-9_-]{0,79}$');
ALTER TABLE channels ADD CONSTRAINT channels_name_key UNIQUE (name);

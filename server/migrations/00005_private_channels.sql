-- SPDX-License-Identifier: Apache-2.0
--
-- Public and private channels, and channel managers. Only managers (and the
-- administrator) add people to private channels.

-- +goose Up
ALTER TABLE channels
    ADD COLUMN visibility text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
    -- Everyone is a member of a default channel: it cannot be private.
    ADD CONSTRAINT channels_default_is_public CHECK (visibility = 'public' OR NOT is_default);

ALTER TABLE channel_members
    ADD COLUMN role text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'manager'));

-- Whoever created a channel manages it.
UPDATE channel_members m SET role = 'manager'
FROM channels c
WHERE c.id = m.channel_id AND c.created_by = m.user_id;

-- +goose Down
ALTER TABLE channel_members DROP COLUMN role;
ALTER TABLE channels DROP CONSTRAINT channels_default_is_public, DROP COLUMN visibility;

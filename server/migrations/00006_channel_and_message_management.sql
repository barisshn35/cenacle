-- SPDX-License-Identifier: Apache-2.0
--
-- Editing and deleting messages, archiving channels, and channel categories.

-- +goose Up
ALTER TABLE messages
    ADD COLUMN edited_at  timestamptz,
    -- Deleted messages can be restored for a short time, then are removed.
    ADD COLUMN deleted_at timestamptz,
    ADD COLUMN deleted_by uuid REFERENCES users (id) ON DELETE SET NULL;

CREATE TABLE channel_categories (
    id         uuid        PRIMARY KEY DEFAULT uuidv7(),
    name       text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80 AND name = btrim(name)),
    position   integer     NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX channel_categories_name_lower_idx ON channel_categories (lower(name));

ALTER TABLE channels
    -- Archived channels are read-only and leave the sidebar; they can be restored.
    ADD COLUMN archived_at timestamptz,
    ADD COLUMN category_id uuid REFERENCES channel_categories (id) ON DELETE SET NULL,
    ADD CONSTRAINT channels_mandatory_not_archived CHECK (NOT is_mandatory OR archived_at IS NULL);

-- +goose Down
ALTER TABLE channels
    DROP CONSTRAINT channels_mandatory_not_archived,
    DROP COLUMN category_id,
    DROP COLUMN archived_at;
DROP TABLE channel_categories;
ALTER TABLE messages DROP COLUMN deleted_by, DROP COLUMN deleted_at, DROP COLUMN edited_at;

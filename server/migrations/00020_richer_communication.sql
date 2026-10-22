-- +goose Up
-- Richer communication: link previews, voice messages and clips, forwarding,
-- custom emoji and stickers, @here/@channel/role mentions, burn-on-read.

-- Pictures also hold link preview images (JPEG for photos).
ALTER TABLE pictures DROP CONSTRAINT pictures_content_type_check;
ALTER TABLE pictures ADD CONSTRAINT pictures_content_type_check
    CHECK (content_type IN ('image/png', 'image/gif', 'image/jpeg'));

-- Link previews, fetched by the server (SSRF-guarded) and shared by every
-- message linking the same address. ok = false: nothing usable (kept so the
-- address is not fetched again soon).
CREATE TABLE link_previews (
    url         text        PRIMARY KEY CHECK (char_length(url) <= 2048),
    ok          boolean     NOT NULL,
    title       text        NOT NULL DEFAULT '' CHECK (char_length(title) <= 300),
    description text        NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
    site_name   text        NOT NULL DEFAULT '' CHECK (char_length(site_name) <= 200),
    image_id    uuid        REFERENCES pictures (id) ON DELETE SET NULL,
    fetched_at  timestamptz NOT NULL DEFAULT now()
);

-- Custom emoji (:name:) and stickers of a workspace.
CREATE TABLE custom_emoji (
    id           uuid        PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    name         text        NOT NULL CHECK (name ~ '^[a-z0-9_+-]{2,32}$'),
    picture_id   uuid        NOT NULL REFERENCES pictures (id),
    created_by   uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, name)
);
CREATE TABLE stickers (
    id           uuid        PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    name         text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
    picture_id   uuid        NOT NULL REFERENCES pictures (id),
    created_by   uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stickers_workspace_idx ON stickers (workspace_id, created_at);

ALTER TABLE messages
    -- The first link of the text and where its preview stands.
    ADD COLUMN link_url   text CHECK (char_length(link_url) <= 2048),
    ADD COLUMN link_state text CHECK (link_state IN ('pending', 'done', 'hidden')),
    -- A forwarded message: a snapshot of the original (author, text, channel, time).
    ADD COLUMN forward    jsonb,
    ADD COLUMN sticker_id uuid REFERENCES stickers (id) ON DELETE SET NULL,
    -- Burn-on-read: each recipient sees the text once, for this many seconds.
    ADD COLUMN burn_seconds integer CHECK (burn_seconds BETWEEN 10 AND 86400);
-- A sticker is a message of its own.
ALTER TABLE messages DROP CONSTRAINT messages_body_check;
ALTER TABLE messages ADD CONSTRAINT messages_body_check
    CHECK (char_length(body) <= 4000 AND (body <> '' OR attachments <> '[]'::jsonb OR has_files OR sticker_id IS NOT NULL));
CREATE INDEX messages_link_pending_idx ON messages (id) WHERE link_state = 'pending';
CREATE INDEX messages_burn_idx ON messages (created_at) WHERE burn_seconds IS NOT NULL;

-- Who has revealed a burn-on-read message, and when.
CREATE TABLE burn_reveals (
    message_id  uuid        NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    revealed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id)
);

-- Voice messages and clips: recorded in the app, with their length and a
-- waveform (up to 64 levels, 0-255) for voice.
ALTER TABLE files
    ADD COLUMN media_kind  text CHECK (media_kind IN ('voice', 'clip')),
    ADD COLUMN duration_ms integer CHECK (duration_ms BETWEEN 0 AND 3600000),
    ADD COLUMN waveform    bytea CHECK (octet_length(waveform) <= 64);

-- Mentions of everyone in a channel (@channel, @everyone), of those online
-- (@here) and of a workspace role (@admins) are recorded per person too, so
-- counts and notifications treat them as mentions.
ALTER TABLE message_mentions
    ADD COLUMN kind text NOT NULL DEFAULT 'person' CHECK (kind IN ('person', 'channel', 'here', 'role'));

-- +goose Down
ALTER TABLE message_mentions DROP COLUMN kind;
ALTER TABLE files DROP COLUMN waveform, DROP COLUMN duration_ms, DROP COLUMN media_kind;
DROP TABLE burn_reveals;
DROP INDEX messages_burn_idx;
DROP INDEX messages_link_pending_idx;
DELETE FROM messages WHERE body = '' AND attachments = '[]'::jsonb AND NOT has_files;
ALTER TABLE messages DROP CONSTRAINT messages_body_check;
ALTER TABLE messages ADD CONSTRAINT messages_body_check
    CHECK (char_length(body) <= 4000 AND (body <> '' OR attachments <> '[]'::jsonb OR has_files));
ALTER TABLE messages
    DROP COLUMN burn_seconds, DROP COLUMN sticker_id, DROP COLUMN forward,
    DROP COLUMN link_state, DROP COLUMN link_url;
DROP TABLE stickers;
DROP TABLE custom_emoji;
DROP TABLE link_previews;
DELETE FROM pictures WHERE content_type = 'image/jpeg';
ALTER TABLE pictures DROP CONSTRAINT pictures_content_type_check;
ALTER TABLE pictures ADD CONSTRAINT pictures_content_type_check
    CHECK (content_type IN ('image/png', 'image/gif'));

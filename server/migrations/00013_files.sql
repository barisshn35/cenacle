-- +goose Up
-- Files people upload into channels. The bytes live in the object store under
-- files/<id> (and thumbs/<id>); this table holds what the app knows about them.
CREATE TABLE files (
    id            uuid        PRIMARY KEY DEFAULT uuidv7(),
    workspace_id  uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    channel_id    uuid        NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    uploader_id   uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- Set when a message carries the file; the purge of a deleted message
    -- clears it, and files that were attached once are then removed.
    message_id    uuid        REFERENCES messages (id) ON DELETE SET NULL,
    attached_at   timestamptz,
    name          text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
    -- As detected from the content for images, else as declared.
    content_type  text        NOT NULL,
    size          bigint      NOT NULL CHECK (size > 0),
    -- uploading: the browser has the upload form; ready: checked and usable;
    -- blocked: the virus scanner found something (the bytes are gone).
    status        text        NOT NULL DEFAULT 'uploading'
                  CHECK (status IN ('uploading', 'ready', 'blocked')),
    width         integer,
    height        integer,
    has_thumbnail boolean     NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX files_message_idx ON files (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX files_channel_idx ON files (channel_id, id DESC) WHERE message_id IS NOT NULL;
CREATE INDEX files_unattached_idx ON files (created_at) WHERE message_id IS NULL;

-- A message may consist of files only.
ALTER TABLE messages ADD COLUMN has_files boolean NOT NULL DEFAULT false;
ALTER TABLE messages DROP CONSTRAINT messages_body_check;
ALTER TABLE messages ADD CONSTRAINT messages_body_check
    CHECK (char_length(body) <= 4000 AND (body <> '' OR attachments <> '[]'::jsonb OR has_files));

-- +goose Down
DELETE FROM messages WHERE body = '' AND attachments = '[]'::jsonb;
ALTER TABLE messages DROP CONSTRAINT messages_body_check;
ALTER TABLE messages ADD CONSTRAINT messages_body_check
    CHECK (char_length(body) <= 4000 AND (body <> '' OR attachments <> '[]'::jsonb));
ALTER TABLE messages DROP COLUMN has_files;
DROP TABLE files;

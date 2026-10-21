-- SPDX-License-Identifier: Apache-2.0
--
-- Channels and messages (v0.4). Workspaces, categories and channel types
-- follow in v0.5 and v0.6; until then every signed-in user can read and
-- write every channel.

-- +goose Up
CREATE TABLE channels (
    id         uuid        PRIMARY KEY DEFAULT uuidv7(),
    name       text        NOT NULL UNIQUE CHECK (name ~ '^[a-z0-9][a-z0-9_-]{0,79}$'),
    topic      text        NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO channels (name, topic) VALUES ('general', 'Anything and everything.');

CREATE TABLE messages (
    -- uuidv7: ids sort by creation time, so (channel_id, id) is the timeline
    -- and the pagination cursor.
    id         uuid        PRIMARY KEY DEFAULT uuidv7(),
    channel_id uuid        NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    author_id  uuid        NOT NULL REFERENCES users (id),
    -- Markdown source as typed; never HTML.
    body       text        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
    -- Chosen by the client per message: a retried send returns the same message.
    nonce      text        NOT NULL CHECK (char_length(nonce) BETWEEN 8 AND 64),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT messages_author_nonce_key UNIQUE (author_id, nonce)
);

CREATE INDEX messages_channel_id_id_idx ON messages (channel_id, id DESC);

-- +goose Down
DROP TABLE messages;
DROP TABLE channels;

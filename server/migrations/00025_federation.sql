-- +goose Up
-- Federation: a workspace connects to a workspace of another Cenacle server
-- and shares channels with it; messages, edits, deletions and reactions go
-- both ways. People of the other server appear as guests named after it.

-- A connection to another server. Both sides hold the same secret: requests
-- are signed with it and name the receiver's connection id.
CREATE TABLE federation_connections (
    id           uuid        PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    name         text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    url          text        NOT NULL CHECK (char_length(url) <= 500),
    secret       text        NOT NULL,
    -- The id the other server gave this connection (named in our requests).
    remote_id    uuid,
    status       text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled')),
    last_error   text        NOT NULL DEFAULT '',
    last_seen_at timestamptz,
    created_by   uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX federation_connections_workspace_idx ON federation_connections (workspace_id);

-- An invitation for another server to connect (its code is shown once).
CREATE TABLE federation_invites (
    id           uuid        PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    name         text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    token_hash   bytea       NOT NULL UNIQUE,
    secret       text        NOT NULL,
    created_by   uuid        REFERENCES users (id) ON DELETE SET NULL,
    expires_at   timestamptz NOT NULL,
    used_at      timestamptz
);

-- A local channel shared over a connection, and its id on the other side
-- (unknown until the other side accepts).
CREATE TABLE shared_channels (
    channel_id        uuid        NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    connection_id     uuid        NOT NULL REFERENCES federation_connections (id) ON DELETE CASCADE,
    remote_channel_id uuid,
    status            text        NOT NULL DEFAULT 'offered' CHECK (status IN ('offered', 'active')),
    created_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, connection_id),
    UNIQUE (connection_id, remote_channel_id)
);

-- Channels the other side offered, waiting for an admin here.
CREATE TABLE channel_offers (
    id                uuid        PRIMARY KEY DEFAULT uuidv7(),
    connection_id     uuid        NOT NULL REFERENCES federation_connections (id) ON DELETE CASCADE,
    remote_channel_id uuid        NOT NULL,
    name              text        NOT NULL,
    topic             text        NOT NULL DEFAULT '',
    created_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (connection_id, remote_channel_id)
);

-- Which local message is which message on the other side.
CREATE TABLE federated_messages (
    message_id        uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    connection_id     uuid NOT NULL REFERENCES federation_connections (id) ON DELETE CASCADE,
    remote_message_id uuid NOT NULL,
    PRIMARY KEY (message_id, connection_id),
    UNIQUE (connection_id, remote_message_id)
);

-- Events waiting to be sent over a connection.
CREATE TABLE federation_deliveries (
    id              uuid        PRIMARY KEY DEFAULT uuidv7(),
    connection_id   uuid        NOT NULL REFERENCES federation_connections (id) ON DELETE CASCADE,
    event           jsonb       NOT NULL,
    attempts        integer     NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX federation_deliveries_due_idx ON federation_deliveries (next_attempt_at);

-- +goose Down
DROP TABLE federation_deliveries;
DROP TABLE federated_messages;
DROP TABLE channel_offers;
DROP TABLE shared_channels;
DROP TABLE federation_invites;
DROP TABLE federation_connections;

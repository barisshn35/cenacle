-- +goose Up
-- Assistants over MCP (ADR 0056): the installation allows them, people make
-- personal tokens, and an assistant may leave a draft in a message box.
ALTER TABLE instance_settings ADD COLUMN assistants_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE assistant_tokens (
    id           uuid PRIMARY KEY DEFAULT uuidv7(),
    user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    token_hash   bytea NOT NULL UNIQUE,
    scopes       text[] NOT NULL CHECK (scopes <@ ARRAY['read', 'draft']::text[] AND 'read' = ANY (scopes)),
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    last_used_at timestamptz,
    revoked_at   timestamptz
);
CREATE INDEX assistant_tokens_user ON assistant_tokens (user_id, created_at DESC);

-- A draft an assistant left for its person in a channel (one per channel).
CREATE TABLE assistant_drafts (
    user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    channel_id uuid NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    root_id    uuid REFERENCES messages (id) ON DELETE CASCADE,
    body       text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
    token_id   uuid REFERENCES assistant_tokens (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, channel_id)
);

-- +goose Down
DROP TABLE assistant_drafts;
DROP TABLE assistant_tokens;
ALTER TABLE instance_settings DROP COLUMN assistants_enabled;

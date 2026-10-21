-- SPDX-License-Identifier: Apache-2.0
--
-- Bots (out-of-process integrations): bot accounts, scoped API tokens and incoming
-- webhooks (generic and Jira).

-- +goose Up
-- A bot is a user that never signs in (auth_service 'bot'); its messages show a badge.
ALTER TABLE users ADD COLUMN is_bot boolean NOT NULL DEFAULT false;

CREATE TABLE bots (
    id           uuid        PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    user_id      uuid        NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
    description  text        NOT NULL DEFAULT '' CHECK (char_length(description) <= 250),
    created_by   uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    -- Disabled bots cannot use their tokens or webhooks; enabling restores them.
    disabled_at  timestamptz
);
CREATE INDEX bots_workspace_idx ON bots (workspace_id);

-- API tokens of a bot: SHA-256 of the token, scopes, optional expiry.
CREATE TABLE bot_tokens (
    id           uuid        PRIMARY KEY DEFAULT uuidv7(),
    bot_id       uuid        NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    name         text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    token_hash   bytea       NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    scopes       text[]      NOT NULL,
    created_by   uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    expires_at   timestamptz,
    revoked_at   timestamptz
);
CREATE INDEX bot_tokens_bot_idx ON bot_tokens (bot_id);

-- Incoming webhooks: a secret URL that posts into one channel as the bot.
CREATE TABLE incoming_webhooks (
    id           uuid        PRIMARY KEY DEFAULT uuidv7(),
    bot_id       uuid        NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    channel_id   uuid        NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    kind         text        NOT NULL CHECK (kind IN ('generic', 'jira')),
    name         text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    token_hash   bytea       NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    created_by   uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz
);
CREATE INDEX incoming_webhooks_bot_idx ON incoming_webhooks (bot_id);

-- +goose Down
DROP TABLE incoming_webhooks;
DROP TABLE bot_tokens;
DROP TABLE bots;
DELETE FROM users WHERE is_bot AND NOT EXISTS (SELECT 1 FROM messages WHERE author_id = users.id);
ALTER TABLE users DROP COLUMN is_bot;

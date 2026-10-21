-- SPDX-License-Identifier: Apache-2.0
--
-- Slash commands, outgoing event subscriptions with a delivery log, scheduled messages
-- and reminders, GitLab and alert webhooks, and a system bot per workspace.

-- +goose Up
-- Custom slash commands of a workspace, answered by a bot's server.
CREATE TABLE slash_commands (
    id           uuid        PRIMARY KEY DEFAULT uuidv7(),
    bot_id       uuid        NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    workspace_id uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    trigger      text        NOT NULL CHECK (trigger ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
    url          text        NOT NULL CHECK (char_length(url) <= 2000),
    description  text        NOT NULL DEFAULT '' CHECK (char_length(description) <= 200),
    hint         text        NOT NULL DEFAULT '' CHECK (char_length(hint) <= 100),
    -- Signs the requests Cenacle sends (HMAC-SHA256); the bot verifies them.
    secret       text        NOT NULL,
    created_by   uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX slash_commands_trigger_idx ON slash_commands (workspace_id, trigger);

-- Events a bot receives at its address, signed like slash command requests.
CREATE TABLE event_subscriptions (
    id          uuid        PRIMARY KEY DEFAULT uuidv7(),
    bot_id      uuid        NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    url         text        NOT NULL CHECK (char_length(url) <= 2000),
    events      text[]      NOT NULL,
    secret      text        NOT NULL,
    created_by  uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    disabled_at timestamptz
);
CREATE INDEX event_subscriptions_bot_idx ON event_subscriptions (bot_id);

-- One delivery per subscription and event: the delivery log, retried with backoff.
CREATE TABLE event_deliveries (
    id              uuid        PRIMARY KEY DEFAULT uuidv7(),
    subscription_id uuid        NOT NULL REFERENCES event_subscriptions (id) ON DELETE CASCADE,
    event_type      text        NOT NULL,
    payload         jsonb       NOT NULL,
    status          text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
    attempts        integer     NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    last_status     integer,
    last_error      text        NOT NULL DEFAULT '',
    created_at      timestamptz NOT NULL DEFAULT now(),
    delivered_at    timestamptz
);
CREATE INDEX event_deliveries_due_idx ON event_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX event_deliveries_subscription_idx ON event_deliveries (subscription_id, id DESC);

-- Messages to send later: scheduled by people, or reminders sent by the system bot.
CREATE TABLE scheduled_messages (
    id          uuid        PRIMARY KEY DEFAULT uuidv7(),
    kind        text        NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'reminder')),
    channel_id  uuid        NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    author_id   uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- Who asked for it (the author, or the person a reminder is for).
    owner_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    body        text        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
    send_at     timestamptz NOT NULL,
    status      text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'canceled')),
    error       text        NOT NULL DEFAULT '',
    message_id  uuid,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scheduled_messages_due_idx ON scheduled_messages (send_at) WHERE status = 'pending';
CREATE INDEX scheduled_messages_owner_idx ON scheduled_messages (owner_id, send_at);

-- The workspace's own "Cenacle" bot (reminders); not shown among the admins' bots.
ALTER TABLE bots ADD COLUMN is_system boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX bots_system_idx ON bots (workspace_id) WHERE is_system;

ALTER TABLE incoming_webhooks DROP CONSTRAINT incoming_webhooks_kind_check;
ALTER TABLE incoming_webhooks ADD CONSTRAINT incoming_webhooks_kind_check
    CHECK (kind IN ('generic', 'jira', 'gitlab', 'alertmanager'));

-- Token rotation: the old token keeps working until its overlap ends (expires_at).

-- +goose Down
DELETE FROM incoming_webhooks WHERE kind NOT IN ('generic', 'jira');
ALTER TABLE incoming_webhooks DROP CONSTRAINT incoming_webhooks_kind_check;
ALTER TABLE incoming_webhooks ADD CONSTRAINT incoming_webhooks_kind_check CHECK (kind IN ('generic', 'jira'));
DROP INDEX bots_system_idx;
ALTER TABLE bots DROP COLUMN is_system;
DROP TABLE scheduled_messages;
DROP TABLE event_deliveries;
DROP TABLE event_subscriptions;
DROP TABLE slash_commands;

-- +goose Up
-- Message priority (v0.32): a message in a channel's timeline can be marked
-- important or urgent, ask its readers to acknowledge it, and (urgent, with
-- mentions) remind the people it mentions until they acknowledge it.
ALTER TABLE messages
    ADD COLUMN priority      text CHECK (priority IN ('important', 'urgent')),
    ADD COLUMN ack_requested boolean NOT NULL DEFAULT false,
    ADD COLUMN persistent    boolean NOT NULL DEFAULT false,
    ADD CONSTRAINT messages_persistent_urgent CHECK (NOT persistent OR priority = 'urgent');
CREATE INDEX messages_persistent_idx ON messages (created_at) WHERE persistent;

CREATE TABLE message_acks (
    message_id uuid        NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    acked_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id)
);

-- Reminders sent for persistent messages, per person.
CREATE TABLE message_reminders (
    message_id uuid        NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    sent       integer     NOT NULL DEFAULT 0,
    last_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id)
);

-- A workspace's rules for persistent notifications: on or off, how often and
-- how many times.
ALTER TABLE workspaces
    ADD COLUMN persistent_notifications boolean NOT NULL DEFAULT true,
    ADD COLUMN persistent_every_minutes integer NOT NULL DEFAULT 5 CHECK (persistent_every_minutes BETWEEN 1 AND 60),
    ADD COLUMN persistent_times         integer NOT NULL DEFAULT 6 CHECK (persistent_times BETWEEN 1 AND 20);

-- +goose Down
ALTER TABLE workspaces
    DROP COLUMN persistent_times,
    DROP COLUMN persistent_every_minutes,
    DROP COLUMN persistent_notifications;
DROP TABLE message_reminders;
DROP TABLE message_acks;
DROP INDEX messages_persistent_idx;
ALTER TABLE messages
    DROP CONSTRAINT messages_persistent_urgent,
    DROP COLUMN persistent,
    DROP COLUMN ack_requested,
    DROP COLUMN priority;

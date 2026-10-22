-- +goose Up
-- Threads (replies to a message), pinned messages and saved messages.

-- A reply belongs to the first message of its thread (root_id), in the same
-- channel. It shows in the channel's timeline too only when its author also
-- sent it to the channel. Deleting a root deletes its replies with it (as the
-- deleted root is purged).
ALTER TABLE messages
    ADD COLUMN root_id         uuid REFERENCES messages (id) ON DELETE CASCADE,
    ADD COLUMN also_in_channel boolean NOT NULL DEFAULT false,
    ADD COLUMN pinned_at       timestamptz,
    ADD COLUMN pinned_by       uuid REFERENCES users (id) ON DELETE SET NULL,
    ADD CONSTRAINT messages_also_in_channel_reply CHECK (NOT also_in_channel OR root_id IS NOT NULL);
CREATE INDEX messages_root_idx ON messages (root_id, id) WHERE root_id IS NOT NULL;
CREATE INDEX messages_pinned_idx ON messages (channel_id, pinned_at DESC) WHERE pinned_at IS NOT NULL;
-- Reactions to one's messages (activity).
CREATE INDEX messages_author_idx ON messages (author_id, id DESC);

-- Threads people follow (authors of the root and of replies, people mentioned in
-- them, or by choice) and how far they read each.
CREATE TABLE thread_follows (
    user_id      uuid    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    root_id      uuid    NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    following    boolean NOT NULL DEFAULT true,
    last_read_id uuid,
    PRIMARY KEY (user_id, root_id)
);
CREATE INDEX thread_follows_root_idx ON thread_follows (root_id) WHERE following;

-- Messages people saved for later, with an optional reminder (a scheduled
-- message from the system bot).
CREATE TABLE saved_messages (
    user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    message_id  uuid        NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    created_at  timestamptz NOT NULL DEFAULT now(),
    remind_at   timestamptz,
    reminder_id uuid REFERENCES scheduled_messages (id) ON DELETE SET NULL,
    done_at     timestamptz,
    PRIMARY KEY (user_id, message_id)
);
CREATE INDEX saved_messages_user_idx ON saved_messages (user_id, created_at DESC);

-- +goose Down
DROP TABLE saved_messages;
DROP TABLE thread_follows;
DROP INDEX messages_author_idx;
ALTER TABLE messages
    DROP CONSTRAINT messages_also_in_channel_reply,
    DROP COLUMN pinned_by,
    DROP COLUMN pinned_at,
    DROP COLUMN also_in_channel,
    DROP COLUMN root_id;

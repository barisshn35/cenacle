-- SPDX-License-Identifier: Apache-2.0
--
-- Transactional outbox for live events, reactions, mentions and message attachments.

-- +goose Up
-- Events written in the same transaction as the change they describe; a relay moves
-- them to the live event stream in order (ADR 0011).
CREATE TABLE event_outbox (
    id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    type       text        NOT NULL,
    data       jsonb       NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE message_reactions (
    message_id uuid        NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    emoji      text        NOT NULL CHECK (octet_length(emoji) BETWEEN 1 AND 64),
    user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, emoji, user_id)
);

-- People a message mentions (members of its channel when it was sent).
CREATE TABLE message_mentions (
    message_id uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, user_id)
);
CREATE INDEX message_mentions_user_idx ON message_mentions (user_id, message_id);

-- Structured cards (title, link, text, fields) sent with a message, mostly by bots. A
-- message with cards may have no text.
ALTER TABLE messages ADD COLUMN attachments jsonb NOT NULL DEFAULT '[]';
ALTER TABLE messages DROP CONSTRAINT messages_body_check;
ALTER TABLE messages ADD CONSTRAINT messages_body_check
    CHECK (char_length(body) <= 4000 AND (body <> '' OR attachments <> '[]'::jsonb));

-- +goose Down
DELETE FROM messages WHERE body = '';
ALTER TABLE messages DROP CONSTRAINT messages_body_check;
ALTER TABLE messages ADD CONSTRAINT messages_body_check CHECK (char_length(body) BETWEEN 1 AND 4000);
ALTER TABLE messages DROP COLUMN attachments;
DROP TABLE message_mentions;
DROP TABLE message_reactions;
DROP TABLE event_outbox;

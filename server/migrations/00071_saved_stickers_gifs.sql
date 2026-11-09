-- +goose Up
-- Stickers a person saved (from a message or the picker): theirs first in the
-- picker. A sticker taken out of the picker leaves their saved ones too.
CREATE TABLE sticker_saves (
    user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    sticker_id uuid        NOT NULL REFERENCES stickers (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, sticker_id)
);
CREATE INDEX sticker_saves_sticker_idx ON sticker_saves (sticker_id);

-- A person's own GIFs: saved from a message or made from a video, sent again
-- from the picker (as a file of the channel, like any upload).
CREATE TABLE user_gifs (
    id         uuid        PRIMARY KEY DEFAULT uuidv7(),
    user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name       text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
    width      integer     NOT NULL CHECK (width BETWEEN 1 AND 4096),
    height     integer     NOT NULL CHECK (height BETWEEN 1 AND 4096),
    data       bytea       NOT NULL CHECK (octet_length(data) <= 8 * 1024 * 1024),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_gifs_user_idx ON user_gifs (user_id, created_at);

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION erase_user_traces(person uuid) RETURNS void LANGUAGE sql AS $$
    DELETE FROM message_reactions WHERE user_id = person;
    DELETE FROM saved_messages WHERE user_id = person;
    DELETE FROM scheduled_messages WHERE owner_id = person OR author_id = person;
    DELETE FROM push_subscriptions WHERE user_id = person;
    DELETE FROM sessions WHERE user_id = person;
    DELETE FROM user_groups WHERE user_id = person;
    DELETE FROM thread_follows WHERE user_id = person;
    DELETE FROM ai_consents WHERE user_id = person;
    DELETE FROM user_fonts WHERE user_id = person;
    DELETE FROM user_sounds WHERE user_id = person;
    DELETE FROM sticker_saves WHERE user_id = person;
    DELETE FROM user_gifs WHERE user_id = person;
$$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION erase_user_traces(person uuid) RETURNS void LANGUAGE sql AS $$
    DELETE FROM message_reactions WHERE user_id = person;
    DELETE FROM saved_messages WHERE user_id = person;
    DELETE FROM scheduled_messages WHERE owner_id = person OR author_id = person;
    DELETE FROM push_subscriptions WHERE user_id = person;
    DELETE FROM sessions WHERE user_id = person;
    DELETE FROM user_groups WHERE user_id = person;
    DELETE FROM thread_follows WHERE user_id = person;
    DELETE FROM ai_consents WHERE user_id = person;
    DELETE FROM user_fonts WHERE user_id = person;
    DELETE FROM user_sounds WHERE user_id = person;
$$;
-- +goose StatementEnd
DROP TABLE user_gifs;
DROP TABLE sticker_saves;

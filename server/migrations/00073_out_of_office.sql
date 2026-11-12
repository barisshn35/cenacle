-- +goose Up
-- Out of office: from when until when someone is away, and the words their
-- automatic reply carries. ooo_replies notes the direct conversations that got
-- the automatic reply in this absence (one each).
ALTER TABLE users
    ADD COLUMN ooo_from timestamptz,
    ADD COLUMN ooo_until timestamptz,
    ADD COLUMN ooo_message text NOT NULL DEFAULT '' CHECK (char_length(ooo_message) <= 500),
    ADD CONSTRAINT users_ooo_range CHECK (
        (ooo_from IS NULL AND ooo_until IS NULL) OR (ooo_from IS NOT NULL AND ooo_until > ooo_from));

CREATE TABLE ooo_replies (
    user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    channel_id uuid NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    sent_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, channel_id)
);

-- +goose Down
DROP TABLE ooo_replies;
ALTER TABLE users DROP CONSTRAINT users_ooo_range, DROP COLUMN ooo_message, DROP COLUMN ooo_until, DROP COLUMN ooo_from;

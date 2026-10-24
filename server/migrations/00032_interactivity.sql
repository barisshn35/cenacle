-- +goose Up
-- Interactive messages (v0.33): a bot's cards can carry buttons and menus,
-- and a bot can open a dialog (a form) for the person who used them. The
-- bot's interactions address receives both, signed with its own secret.
ALTER TABLE bots
    ADD COLUMN interactions_url    text CHECK (char_length(interactions_url) <= 2000),
    ADD COLUMN interactions_secret text;

-- Dialogs a bot opened, until they are submitted or expire (15 minutes).
CREATE TABLE dialogs (
    id         uuid        PRIMARY KEY DEFAULT uuidv7(),
    bot_id     uuid        NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    channel_id uuid        NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    message_id uuid        REFERENCES messages (id) ON DELETE CASCADE,
    spec       jsonb       NOT NULL,
    expires_at timestamptz NOT NULL DEFAULT now() + interval '15 minutes'
);
CREATE INDEX dialogs_expires_idx ON dialogs (expires_at);

-- +goose Down
DROP TABLE dialogs;
ALTER TABLE bots DROP COLUMN interactions_secret, DROP COLUMN interactions_url;

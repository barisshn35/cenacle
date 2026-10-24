-- +goose Up
-- What notifications outside the app may show (v0.34): web push and desktop
-- notifications the full text, the sender and channel only, or nothing but
-- that something came; e-mails the full text or the sender and channel.
ALTER TABLE instance_settings
    ADD COLUMN push_contents  text NOT NULL DEFAULT 'full' CHECK (push_contents IN ('full', 'sender', 'none')),
    ADD COLUMN email_contents text NOT NULL DEFAULT 'full' CHECK (email_contents IN ('full', 'sender'));

-- +goose Down
ALTER TABLE instance_settings DROP COLUMN email_contents, DROP COLUMN push_contents;

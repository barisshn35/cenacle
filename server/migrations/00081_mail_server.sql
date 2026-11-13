-- +goose Up
-- The outgoing mail server administrators set in the app (1.0): where meeting
-- invitations and notification e-mails go out. CENACLE_SMTP_HOST overrides it.
-- An empty host: no e-mail. The password is never shown again once saved.
ALTER TABLE instance_settings
    ADD COLUMN smtp_host     text NOT NULL DEFAULT '' CHECK (char_length(smtp_host) <= 253),
    ADD COLUMN smtp_port     integer NOT NULL DEFAULT 587 CHECK (smtp_port BETWEEN 1 AND 65535),
    ADD COLUMN smtp_security text NOT NULL DEFAULT 'starttls' CHECK (smtp_security IN ('starttls', 'tls', 'none')),
    ADD COLUMN smtp_username text NOT NULL DEFAULT '' CHECK (char_length(smtp_username) <= 320),
    ADD COLUMN smtp_password text NOT NULL DEFAULT '' CHECK (char_length(smtp_password) <= 500),
    ADD COLUMN smtp_from     text NOT NULL DEFAULT '' CHECK (char_length(smtp_from) <= 400);

-- +goose Down
ALTER TABLE instance_settings
    DROP COLUMN smtp_from, DROP COLUMN smtp_password, DROP COLUMN smtp_username,
    DROP COLUMN smtp_security, DROP COLUMN smtp_port, DROP COLUMN smtp_host;

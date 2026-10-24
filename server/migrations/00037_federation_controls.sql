-- +goose Up
-- Federation controls (v0.35): which servers this installation may connect to
-- (every one, only those listed, or all but those listed), and per connection
-- what is taken from the other server and how often it may send.
ALTER TABLE instance_settings
    ADD COLUMN federation_mode    text   NOT NULL DEFAULT 'open' CHECK (federation_mode IN ('open', 'allow', 'deny')),
    ADD COLUMN federation_servers text[] NOT NULL DEFAULT '{}';
ALTER TABLE federation_connections
    ADD COLUMN receive_messages    boolean NOT NULL DEFAULT true,
    ADD COLUMN receive_reactions   boolean NOT NULL DEFAULT true,
    ADD COLUMN receive_edits       boolean NOT NULL DEFAULT true,
    ADD COLUMN requests_per_minute integer NOT NULL DEFAULT 120 CHECK (requests_per_minute BETWEEN 1 AND 6000);

-- +goose Down
ALTER TABLE federation_connections
    DROP COLUMN requests_per_minute, DROP COLUMN receive_edits, DROP COLUMN receive_reactions,
    DROP COLUMN receive_messages;
ALTER TABLE instance_settings DROP COLUMN federation_servers, DROP COLUMN federation_mode;

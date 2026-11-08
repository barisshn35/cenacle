-- +goose Up
-- The installation's default notification sounds and volume, chosen by its
-- administrators: what people hear until they choose their own.
ALTER TABLE instance_settings
    ADD COLUMN sound_mention  text    NOT NULL DEFAULT 'chime' CHECK (sound_mention ~ '^[a-z]{2,20}$'),
    ADD COLUMN sound_direct   text    NOT NULL DEFAULT 'pop' CHECK (sound_direct ~ '^[a-z]{2,20}$'),
    ADD COLUMN sound_message  text    NOT NULL DEFAULT 'drop' CHECK (sound_message ~ '^[a-z]{2,20}$'),
    ADD COLUMN sound_volume   integer NOT NULL DEFAULT 70 CHECK (sound_volume BETWEEN 0 AND 100);

-- +goose Down
ALTER TABLE instance_settings
    DROP COLUMN sound_volume, DROP COLUMN sound_message, DROP COLUMN sound_direct, DROP COLUMN sound_mention;

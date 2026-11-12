-- +goose Up
-- A group conversation's own name, given by its people ('' when it has none).
ALTER TABLE channels ADD COLUMN title text NOT NULL DEFAULT '' CHECK (char_length(title) <= 80);

-- +goose Down
ALTER TABLE channels DROP COLUMN title;

-- +goose Up
-- A raised hand in a call: when the person raised it (NULL when lowered).
ALTER TABLE call_participants ADD COLUMN hand_raised_at timestamptz;

-- +goose Down
ALTER TABLE call_participants DROP COLUMN hand_raised_at;

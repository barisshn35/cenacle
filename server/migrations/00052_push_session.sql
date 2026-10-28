-- +goose Up
-- A browser's push subscription belongs to the session that made it, so every
-- way a session ends (sign-out, ending a device, sign-out everywhere, the
-- directory, expiry) stops its pushes too. Earlier rows have no session; they
-- go, and browsers subscribe again on their next visit.
DELETE FROM push_subscriptions;
ALTER TABLE push_subscriptions
    ADD COLUMN session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE;
CREATE INDEX push_subscriptions_session_idx ON push_subscriptions (session_id);

-- +goose Down
DROP INDEX push_subscriptions_session_idx;
ALTER TABLE push_subscriptions DROP COLUMN session_id;

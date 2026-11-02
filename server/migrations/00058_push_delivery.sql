-- +goose Up
-- Web push notes how far it got per person, not per message, so a message
-- with more people than one page reaches all of them. Earlier cursors point
-- at a message that was finished: they stay finished.
ALTER TABLE notify_cursors
    ADD COLUMN cursor_user uuid NOT NULL DEFAULT 'ffffffff-ffff-ffff-ffff-ffffffffffff';
-- A push endpoint that fails rests for a while (longer each time) instead of
-- holding up everyone else's pushes on every run.
ALTER TABLE push_subscriptions
    ADD COLUMN failures int NOT NULL DEFAULT 0,
    ADD COLUMN retry_at timestamptz;

-- +goose Down
ALTER TABLE push_subscriptions DROP COLUMN retry_at, DROP COLUMN failures;
ALTER TABLE notify_cursors DROP COLUMN cursor_user;

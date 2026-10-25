-- +goose Up
-- Mentions carry the channel of their message (messages never change channel),
-- so that a person's unread mentions in a channel are one index range from the
-- last message they read, however many mentions they have elsewhere.
ALTER TABLE message_mentions ADD COLUMN channel_id uuid;
UPDATE message_mentions mm SET channel_id = m.channel_id FROM messages m WHERE m.id = mm.message_id;
ALTER TABLE message_mentions ALTER COLUMN channel_id SET NOT NULL;
CREATE INDEX message_mentions_user_channel_idx ON message_mentions (user_id, channel_id, message_id);

-- +goose Down
DROP INDEX message_mentions_user_channel_idx;
ALTER TABLE message_mentions DROP COLUMN channel_id;

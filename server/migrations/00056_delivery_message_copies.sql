-- +goose Up
-- Queued bot and federation deliveries are copies of a message: they name it,
-- so they go when it goes. A deletion (message.deleted) carries no content and
-- names no message here, so it still reaches the bot or the other server.
ALTER TABLE event_deliveries ADD COLUMN message_id uuid REFERENCES messages (id) ON DELETE CASCADE;
ALTER TABLE federation_deliveries ADD COLUMN message_id uuid REFERENCES messages (id) ON DELETE CASCADE;
CREATE INDEX event_deliveries_message_idx ON event_deliveries (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX federation_deliveries_message_idx ON federation_deliveries (message_id) WHERE message_id IS NOT NULL;

UPDATE event_deliveries d SET message_id = m.id FROM messages m
WHERE d.event_type <> 'message.deleted'
  AND m.id = coalesce(d.payload ->> 'message_id', d.payload ->> 'id')::uuid;
-- Copies of messages deleted already, or gone, go now.
DELETE FROM event_deliveries d WHERE d.event_type <> 'message.deleted'
  AND (d.message_id IS NULL OR EXISTS (SELECT 1 FROM messages m WHERE m.id = d.message_id AND m.deleted_at IS NOT NULL));

UPDATE federation_deliveries d SET message_id = m.id FROM messages m
WHERE d.event ->> 'type' <> 'message.deleted' AND m.id = (d.event -> 'message' ->> 'ours')::uuid;
UPDATE federation_deliveries d SET message_id = f.message_id FROM federated_messages f
WHERE d.message_id IS NULL AND d.event ->> 'type' <> 'message.deleted'
  AND f.connection_id = d.connection_id AND f.remote_message_id = (d.event -> 'message' ->> 'yours')::uuid;
DELETE FROM federation_deliveries d USING messages m
WHERE m.id = d.message_id AND m.deleted_at IS NOT NULL;

-- A deleted message's queued copies go in the transaction that deletes it
-- (by its author, a moderator, an erasure, a spillage decision or a timer).
-- +goose StatementBegin
CREATE FUNCTION messages_drop_queued_copies() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM event_deliveries WHERE message_id = NEW.id;
    DELETE FROM federation_deliveries WHERE message_id = NEW.id;
    RETURN NULL;
END;
$$;
-- +goose StatementEnd
CREATE TRIGGER messages_drop_queued_copies AFTER UPDATE OF deleted_at ON messages
    FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
    EXECUTE FUNCTION messages_drop_queued_copies();

-- Whether a bot may still get a queued event: it is enabled, subscribed and in
-- the event's channel, as when the event was queued (QueueDeliveries).
-- +goose StatementBegin
CREATE FUNCTION delivery_sendable(subscription uuid, payload jsonb) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM event_subscriptions s
        JOIN bots b ON b.id = s.bot_id AND b.disabled_at IS NULL
        JOIN channel_members m ON m.user_id = b.user_id AND m.channel_id = (payload ->> 'channel_id')::uuid
        WHERE s.id = subscription AND s.disabled_at IS NULL);
$$;
-- +goose StatementEnd

-- +goose Down
DROP FUNCTION delivery_sendable(uuid, jsonb);
DROP TRIGGER messages_drop_queued_copies ON messages;
DROP FUNCTION messages_drop_queued_copies();
DROP INDEX federation_deliveries_message_idx;
DROP INDEX event_deliveries_message_idx;
ALTER TABLE federation_deliveries DROP COLUMN message_id;
ALTER TABLE event_deliveries DROP COLUMN message_id;

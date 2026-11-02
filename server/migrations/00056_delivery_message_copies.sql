-- +goose Up
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

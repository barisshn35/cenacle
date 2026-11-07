-- +goose Up
-- Channel lines ("Ada joined", "Can was added by Ada") are messages of the
-- workspace's Cenacle bot whose first card is a channel_event. They never
-- count as unread and never notify.
CREATE FUNCTION channel_line(cards jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(jsonb_typeof(cards) = 'array' AND cards->0 ? 'channel_event', false)
$$;

-- +goose Down
DROP FUNCTION channel_line(jsonb);

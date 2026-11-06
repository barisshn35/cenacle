-- +goose Up
-- Erasing a person also removes the fonts and sounds they uploaded (their
-- profile picture goes in the same transaction, see EraseUser).
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION erase_user_traces(person uuid) RETURNS void LANGUAGE sql AS $$
    DELETE FROM message_reactions WHERE user_id = person;
    DELETE FROM saved_messages WHERE user_id = person;
    DELETE FROM scheduled_messages WHERE owner_id = person OR author_id = person;
    DELETE FROM push_subscriptions WHERE user_id = person;
    DELETE FROM sessions WHERE user_id = person;
    DELETE FROM user_groups WHERE user_id = person;
    DELETE FROM thread_follows WHERE user_id = person;
    DELETE FROM ai_consents WHERE user_id = person;
    DELETE FROM user_fonts WHERE user_id = person;
    DELETE FROM user_sounds WHERE user_id = person;
$$;
-- +goose StatementEnd

-- What points at a picture, indexed: deleting a picture (a new profile picture,
-- an erasure, the clean-up in 00063) otherwise reads each of these tables whole to
-- check its foreign keys.
CREATE INDEX users_avatar_idx ON users (avatar_id) WHERE avatar_id IS NOT NULL;
CREATE INDEX workspaces_icon_idx ON workspaces (icon_id) WHERE icon_id IS NOT NULL;
CREATE INDEX link_previews_image_idx ON link_previews (image_id) WHERE image_id IS NOT NULL;
CREATE INDEX custom_emoji_picture_idx ON custom_emoji (picture_id);
CREATE INDEX stickers_picture_idx ON stickers (picture_id);

-- +goose Down
DROP INDEX stickers_picture_idx;
DROP INDEX custom_emoji_picture_idx;
DROP INDEX link_previews_image_idx;
DROP INDEX workspaces_icon_idx;
DROP INDEX users_avatar_idx;
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION erase_user_traces(person uuid) RETURNS void LANGUAGE sql AS $$
    DELETE FROM message_reactions WHERE user_id = person;
    DELETE FROM saved_messages WHERE user_id = person;
    DELETE FROM scheduled_messages WHERE owner_id = person OR author_id = person;
    DELETE FROM push_subscriptions WHERE user_id = person;
    DELETE FROM sessions WHERE user_id = person;
    DELETE FROM user_groups WHERE user_id = person;
    DELETE FROM thread_follows WHERE user_id = person;
    DELETE FROM ai_consents WHERE user_id = person;
$$;
-- +goose StatementEnd

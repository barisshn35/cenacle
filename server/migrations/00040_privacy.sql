-- +goose Up
-- Data subject requests (v0.36): erasing a person removes what they kept or
-- set for themselves; their messages are handled separately (legal holds).
-- +goose StatementBegin
CREATE FUNCTION erase_user_traces(person uuid) RETURNS void LANGUAGE sql AS $$
    DELETE FROM message_reactions WHERE user_id = person;
    DELETE FROM saved_messages WHERE user_id = person;
    DELETE FROM scheduled_messages WHERE owner_id = person OR author_id = person;
    DELETE FROM push_subscriptions WHERE user_id = person;
    DELETE FROM sessions WHERE user_id = person;
    DELETE FROM user_groups WHERE user_id = person;
    DELETE FROM thread_follows WHERE user_id = person;
$$;
-- +goose StatementEnd

-- +goose Down
DROP FUNCTION erase_user_traces(uuid);

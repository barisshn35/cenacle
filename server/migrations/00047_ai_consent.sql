-- +goose Up
-- A person's answer to the AI notice: whether their requests and the messages
-- the AI reads may go to the model the operator runs. The answer is for one
-- model; when the operator changes it, people are asked again.
CREATE TABLE ai_consents (
  user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  accepted boolean NOT NULL,
  model text NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now()
);

-- Erasing a person also forgets their answer.
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

-- +goose Down
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION erase_user_traces(person uuid) RETURNS void LANGUAGE sql AS $$
    DELETE FROM message_reactions WHERE user_id = person;
    DELETE FROM saved_messages WHERE user_id = person;
    DELETE FROM scheduled_messages WHERE owner_id = person OR author_id = person;
    DELETE FROM push_subscriptions WHERE user_id = person;
    DELETE FROM sessions WHERE user_id = person;
    DELETE FROM user_groups WHERE user_id = person;
    DELETE FROM thread_follows WHERE user_id = person;
$$;
-- +goose StatementEnd
DROP TABLE ai_consents;

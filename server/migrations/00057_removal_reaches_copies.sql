-- +goose Up
-- Removing messages reaches the copies the server keeps of them, and does
-- not take what a legal hold keeps.

-- The message that started a run (keyword and reaction triggers): its text is
-- in the run's variables, which go when the message does.
ALTER TABLE workflow_runs ADD COLUMN trigger_message_id uuid;
CREATE INDEX workflow_runs_trigger_message_idx ON workflow_runs (trigger_message_id)
    WHERE trigger_message_id IS NOT NULL;

-- The message a saved-message reminder is about: the reminder is not sent
-- once the message is deleted or out of its owner's sight.
ALTER TABLE scheduled_messages ADD COLUMN about_message_id uuid;
UPDATE scheduled_messages sm SET about_message_id = s.message_id
FROM saved_messages s WHERE s.reminder_id = sm.id;

-- thread_held: whether a legal hold keeps a reply of a thread. Deleting a
-- root deletes its replies (root_id cascades), so a root with a held reply
-- stays too.
-- +goose StatementBegin
CREATE FUNCTION thread_held(root uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM messages r
        WHERE r.root_id = root AND message_held(r.channel_id, r.author_id, r.created_at))
$$;
-- +goose StatementEnd

-- +goose Down
DROP FUNCTION thread_held(uuid);
ALTER TABLE scheduled_messages DROP COLUMN about_message_id;
ALTER TABLE workflow_runs DROP COLUMN trigger_message_id;

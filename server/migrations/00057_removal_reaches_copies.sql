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

-- A daily archive object whose day lost or changed messages since it was
-- written; the exporter writes it again (or removes it when nothing is left)
-- and it is not served meanwhile.
ALTER TABLE archive_exports ADD COLUMN stale_at timestamptz;
CREATE INDEX archive_exports_stale_idx ON archive_exports (stale_at) WHERE stale_at IS NOT NULL;
-- +goose StatementBegin
CREATE FUNCTION archive_exports_mark_stale() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE archive_exports e SET stale_at = now()
    FROM (SELECT DISTINCT c.workspace_id, (g.created_at AT TIME ZONE 'UTC')::date AS day
          FROM gone g JOIN channels c ON c.id = g.channel_id) d
    WHERE e.workspace_id = d.workspace_id AND e.day = d.day;
    RETURN NULL;
END;
$$;
-- +goose StatementEnd
CREATE TRIGGER messages_archive_stale AFTER DELETE ON messages
    REFERENCING OLD TABLE AS gone FOR EACH STATEMENT EXECUTE FUNCTION archive_exports_mark_stale();

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
DROP TRIGGER messages_archive_stale ON messages;
DROP FUNCTION archive_exports_mark_stale();
ALTER TABLE archive_exports DROP COLUMN stale_at;
ALTER TABLE scheduled_messages DROP COLUMN about_message_id;
ALTER TABLE workflow_runs DROP COLUMN trigger_message_id;

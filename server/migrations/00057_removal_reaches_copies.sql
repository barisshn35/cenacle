-- +goose Up
-- Removing messages reaches the copies the server keeps of them, and does
-- not take what a legal hold keeps.

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

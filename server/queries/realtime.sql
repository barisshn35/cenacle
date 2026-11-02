-- name: ReplayableMessages :many
-- ReplayableMessages keeps the messages whose stored events a resuming
-- connection may still be sent: not deleted (by their author, a moderator, a
-- spillage reviewer, an erasure or a burn) and not by a person who was erased.
-- Purged messages are gone, so they are not returned either.
SELECT m.id FROM messages m JOIN users u ON u.id = m.author_id
WHERE m.id = ANY (@ids::uuid[]) AND m.deleted_at IS NULL AND u.auth_service <> 'erased';

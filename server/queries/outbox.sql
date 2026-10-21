-- name: InsertOutboxEvent :exec
-- InsertOutboxEvent records an event and wakes the relay (notifications are
-- delivered when the transaction commits).
WITH e AS (INSERT INTO event_outbox (type, data) VALUES (@type, @data) RETURNING id)
SELECT pg_notify('cenacle_outbox', '') FROM e;

-- name: ListOutboxEvents :many
SELECT * FROM event_outbox ORDER BY id LIMIT @row_limit;

-- name: DeleteOutboxEvents :exec
DELETE FROM event_outbox WHERE id <= @last_id;

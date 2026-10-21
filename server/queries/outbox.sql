-- name: InsertOutboxEvent :exec
-- InsertOutboxEvent records an event and wakes the relay (notifications are
-- delivered when the transaction commits).
WITH e AS (INSERT INTO event_outbox (type, data) VALUES (@type, @data) RETURNING id)
SELECT pg_notify('cenacle_outbox', '') FROM e;

-- name: ListOutboxEvents :many
SELECT * FROM event_outbox ORDER BY id LIMIT @row_limit;

-- name: DeleteOutboxEvents :exec
-- DeleteOutboxEvents removes exactly the events that were relayed: a lower id
-- that committed later must stay for the next round.
DELETE FROM event_outbox WHERE id = ANY(@ids::bigint[]);

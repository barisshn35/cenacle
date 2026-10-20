-- name: ServerTime :one
-- ServerTime returns the database clock; used as a smoke test of the
-- sqlc/pgx setup.
SELECT now()::timestamptz AS now;

-- +goose Up
-- A connection's events are sent oldest first, and the oldest one decides
-- whether the connection is due (so later events cannot overtake a retry).
CREATE INDEX federation_deliveries_connection_idx ON federation_deliveries (connection_id, id);

-- +goose Down
DROP INDEX federation_deliveries_connection_idx;

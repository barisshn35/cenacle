-- +goose Up
-- When a connection's server last sent a valid request signed only with v1
-- after the connection required v2: it looks moved back below 0.99.2. The
-- workspace's admins see it and may take v1 again (AcceptFederationV1).
ALTER TABLE federation_connections ADD COLUMN v1_refused_at timestamptz;

-- +goose Down
ALTER TABLE federation_connections DROP COLUMN v1_refused_at;

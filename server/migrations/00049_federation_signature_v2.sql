-- +goose Up
-- The signature version a connection's server uses: 1 (time and body signed)
-- until it first signs with v2 (also the connection and the endpoint); from
-- then on, requests without v2 are refused.
ALTER TABLE federation_connections ADD COLUMN signature_version smallint NOT NULL DEFAULT 1;

-- +goose Down
ALTER TABLE federation_connections DROP COLUMN signature_version;

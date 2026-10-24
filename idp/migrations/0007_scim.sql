-- SPDX-License-Identifier: AGPL-3.0-only
-- Cenacle ID: SCIM 2.0 provisioning of an identity provider's people and groups.

-- Up Migration

-- The provider pushes its people with this bearer token (only its SHA-256 is kept).
ALTER TABLE identity_sources
  ADD COLUMN scim_token_hash bytea CHECK (scim_token_hash IS NULL OR octet_length(scim_token_hash) = 32),
  ADD COLUMN scim_token_created_at timestamptz;
CREATE UNIQUE INDEX identity_sources_scim_token ON identity_sources (scim_token_hash)
  WHERE scim_token_hash IS NOT NULL;

-- Accounts and groups the provider manages over SCIM; userName is the provider's
-- name for the person (not a sign-in name here).
ALTER TABLE users
  ADD COLUMN scim_managed boolean NOT NULL DEFAULT false,
  ADD COLUMN scim_user_name text CHECK (scim_user_name IS NULL OR length(scim_user_name) <= 320),
  -- The provider's own id of the person; external_id is what its sign-ins carry.
  ADD COLUMN scim_external_id text CHECK (scim_external_id IS NULL OR length(scim_external_id) <= 500);
CREATE UNIQUE INDEX users_scim_user_name ON users (source_id, lower(scim_user_name))
  WHERE scim_user_name IS NOT NULL;
ALTER TABLE directory_groups
  ADD COLUMN scim_managed boolean NOT NULL DEFAULT false,
  ADD COLUMN scim_external_id text;

-- Down Migration

ALTER TABLE directory_groups DROP COLUMN scim_external_id, DROP COLUMN scim_managed;
DROP INDEX users_scim_user_name;
ALTER TABLE users DROP COLUMN scim_external_id, DROP COLUMN scim_user_name, DROP COLUMN scim_managed;
DROP INDEX identity_sources_scim_token;
ALTER TABLE identity_sources DROP COLUMN scim_token_created_at, DROP COLUMN scim_token_hash;

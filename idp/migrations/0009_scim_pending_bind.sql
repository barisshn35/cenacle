-- SPDX-License-Identifier: AGPL-3.0-only
-- Cenacle ID: an account provisioned over SCIM is bound to the provider's id of
-- the person once, at its first sign-in; a bound account is never bound again.

-- Up Migration

ALTER TABLE users ADD COLUMN scim_pending_bind boolean NOT NULL DEFAULT false;
-- Accounts still under the id SCIM gave them have not been bound yet.
UPDATE users SET scim_pending_bind = true
WHERE scim_managed AND external_id = coalesce(scim_external_id, scim_user_name);

-- Down Migration

ALTER TABLE users DROP COLUMN scim_pending_bind;

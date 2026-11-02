-- SPDX-License-Identifier: AGPL-3.0-only
-- Cenacle ID: safeguards of accounts.
--
-- An administrator's disable is kept apart from the state the account's
-- source (a directory, SCIM) gives it, so no sync, directory sign-in or SCIM
-- push undoes it. An account is disabled while either is set.

-- Up Migration

ALTER TABLE users ADD COLUMN admin_disabled_at timestamptz;

-- Accounts no source manages (local ones, and identity providers' accounts
-- without SCIM) were only ever disabled by an administrator or the CLI.
UPDATE users SET admin_disabled_at = disabled_at, disabled_at = NULL
WHERE disabled_at IS NOT NULL AND NOT scim_managed
  AND (source_id IS NULL OR source_id IN (SELECT id FROM identity_sources WHERE kind <> 'ldap'));

-- Failed sign-in attempts per account (password, second step), recorded
-- before the guess is checked so parallel requests cannot pass the limit;
-- a successful one is removed again.
CREATE TABLE signin_attempts (
  id      uuid        PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind    text        NOT NULL CHECK (kind IN ('password', 'second_step')),
  at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX signin_attempts_user ON signin_attempts (user_id, kind, at);

-- Down Migration

DROP TABLE signin_attempts;

UPDATE users SET disabled_at = coalesce(disabled_at, admin_disabled_at)
WHERE admin_disabled_at IS NOT NULL;
ALTER TABLE users DROP COLUMN admin_disabled_at;

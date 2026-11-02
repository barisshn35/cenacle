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

-- Account pages (/account) are signed in with a stateless cookie: ending a
-- person's sessions (a two-step reset, a deactivation) ends cookies issued
-- before this time too.
ALTER TABLE users ADD COLUMN account_sessions_ended_at timestamptz;

-- A person a directory lists but Cenacle ID cannot keep (their sign-in name
-- belongs to another account) is skipped, and the synchronization goes on.
ALTER TABLE sync_runs ADD COLUMN users_skipped integer NOT NULL DEFAULT 0;

-- Down Migration

ALTER TABLE sync_runs DROP COLUMN users_skipped;
ALTER TABLE users DROP COLUMN account_sessions_ended_at;

DROP TABLE signin_attempts;

UPDATE users SET disabled_at = coalesce(disabled_at, admin_disabled_at)
WHERE admin_disabled_at IS NOT NULL;
ALTER TABLE users DROP COLUMN admin_disabled_at;

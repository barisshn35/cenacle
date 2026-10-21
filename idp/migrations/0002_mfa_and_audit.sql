-- SPDX-License-Identifier: Apache-2.0
-- Cenacle ID: two-step verification (TOTP, recovery codes) and the audit log.

-- Up Migration

-- The TOTP secret is encrypted (AES-256-GCM, IDP_KEY_ENCRYPTION_KEY, bound to the user
-- id). While totp_enabled_at is NULL a stored secret is an unconfirmed setup.
-- totp_last_step is the time step of the last accepted code: a code is accepted once.
ALTER TABLE users
  ADD COLUMN totp_secret_enc bytea,
  ADD COLUMN totp_enabled_at timestamptz,
  ADD COLUMN totp_last_step  bigint;

-- One-time recovery codes, stored as SHA-256 (the codes are random, 50 bits).
CREATE TABLE recovery_codes (
  user_id   uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash bytea       NOT NULL CHECK (octet_length(code_hash) = 32),
  used_at   timestamptz,
  PRIMARY KEY (user_id, code_hash)
);

-- A password check that still needs the second step: bound to an interaction (sign-in
-- for an app) or to the account pages, short-lived, with a limited number of attempts.
CREATE TABLE mfa_challenges (
  id         text        PRIMARY KEY,
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose    text        NOT NULL CHECK (purpose IN ('login', 'account')),
  attempts   integer     NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL
);
CREATE INDEX mfa_challenges_expires_at ON mfa_challenges (expires_at);

-- Who did what with an account, and when: sign-ins, failures, security changes.
CREATE TABLE audit_events (
  id      uuid        PRIMARY KEY DEFAULT uuidv7(),
  at      timestamptz NOT NULL DEFAULT now(),
  user_id uuid        REFERENCES users (id) ON DELETE SET NULL,
  action  text        NOT NULL,
  ip      text        NOT NULL DEFAULT '',
  detail  jsonb       NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_events_user_at ON audit_events (user_id, at DESC);
CREATE INDEX audit_events_at ON audit_events (at DESC);

-- Down Migration

DROP TABLE audit_events;
DROP TABLE mfa_challenges;
DROP TABLE recovery_codes;
ALTER TABLE users
  DROP COLUMN totp_last_step,
  DROP COLUMN totp_enabled_at,
  DROP COLUMN totp_secret_enc;

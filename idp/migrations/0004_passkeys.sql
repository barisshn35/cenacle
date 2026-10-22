-- SPDX-License-Identifier: Apache-2.0
-- Cenacle ID: passkeys (WebAuthn credentials) and their one-time challenges.

-- Up Migration

-- A passkey of an account. id is the credential id (base64url); the public key is the
-- COSE key the authenticator registered; counter guards against cloned authenticators.
CREATE TABLE passkeys (
  id           text        PRIMARY KEY,
  user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  public_key   bytea       NOT NULL,
  counter      bigint      NOT NULL DEFAULT 0,
  transports   text[]      NOT NULL DEFAULT '{}',
  -- singleDevice (a security key) or multiDevice (synced, e.g. by a password manager).
  device_type  text        NOT NULL CHECK (device_type IN ('singleDevice', 'multiDevice')),
  backed_up    boolean     NOT NULL DEFAULT false,
  name         text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX passkeys_user_id ON passkeys (user_id);

-- A WebAuthn challenge: used once, short-lived. A sign-in challenge is bound to an
-- interaction (sign-in for an app) or to the account pages; a registration challenge to
-- the signed-in account.
CREATE TABLE webauthn_challenges (
  id          text        PRIMARY KEY,
  purpose     text        NOT NULL CHECK (purpose IN ('login', 'account', 'register')),
  interaction text,
  user_id     uuid        REFERENCES users (id) ON DELETE CASCADE,
  challenge   text        NOT NULL,
  expires_at  timestamptz NOT NULL
);
CREATE INDEX webauthn_challenges_expires_at ON webauthn_challenges (expires_at);

-- Down Migration

DROP TABLE webauthn_challenges;
DROP TABLE passkeys;

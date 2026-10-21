-- SPDX-License-Identifier: Apache-2.0
-- Cenacle ID: accounts, OIDC artifacts and signing keys.

-- Up Migration

-- Case-insensitive e-mail addresses (trusted extension: the database owner may create it).
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id             uuid        PRIMARY KEY DEFAULT uuidv7(),
  email          citext      NOT NULL UNIQUE,
  email_verified boolean     NOT NULL DEFAULT false,
  display_name   text        NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  -- NULL means the account cannot sign in with a password (e.g. directory accounts, v0.14).
  password_hash  text,
  locale         text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  disabled_at    timestamptz
);

-- One table for every oidc-provider model (sessions, codes, tokens, grants, ...).
CREATE TABLE oidc_payloads (
  model       text        NOT NULL,
  id          text        NOT NULL,
  payload     jsonb       NOT NULL,
  grant_id    text,
  user_code   text,
  uid         text,
  expires_at  timestamptz,
  consumed_at timestamptz,
  PRIMARY KEY (model, id)
);
CREATE INDEX oidc_payloads_grant_id ON oidc_payloads (grant_id) WHERE grant_id IS NOT NULL;
CREATE UNIQUE INDEX oidc_payloads_uid ON oidc_payloads (model, uid) WHERE uid IS NOT NULL;
CREATE UNIQUE INDEX oidc_payloads_user_code ON oidc_payloads (model, user_code) WHERE user_code IS NOT NULL;
CREATE INDEX oidc_payloads_expires_at ON oidc_payloads (expires_at) WHERE expires_at IS NOT NULL;

-- Token signing keys. Private keys are encrypted (AES-256-GCM) with a key that is not
-- stored in the database, so a database dump alone does not reveal them.
CREATE TABLE signing_keys (
  kid             text        PRIMARY KEY,
  alg             text        NOT NULL,
  public_jwk      jsonb       NOT NULL,
  private_jwk_enc bytea       NOT NULL,
  state           text        NOT NULL CHECK (state IN ('active', 'retired')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  retired_at      timestamptz,
  CHECK ((state = 'retired') = (retired_at IS NOT NULL))
);
-- Exactly one signing key per algorithm is active at a time.
CREATE UNIQUE INDEX signing_keys_one_active ON signing_keys (alg) WHERE state = 'active';

-- Down Migration

DROP TABLE signing_keys;
DROP TABLE oidc_payloads;
DROP TABLE users;

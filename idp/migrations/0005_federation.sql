-- SPDX-License-Identifier: Apache-2.0
-- Cenacle ID: signing in with other identity providers (OpenID Connect, SAML 2.0).

-- Up Migration

-- Identity sources are directories (LDAP) or identity providers people sign in with.
ALTER TABLE identity_sources DROP CONSTRAINT identity_sources_kind_check;
ALTER TABLE identity_sources
  ADD CONSTRAINT identity_sources_kind_check CHECK (kind IN ('ldap', 'oidc', 'saml'));

-- A sign-in at another identity provider on its way: found again by its state (OIDC
-- state, SAML RelayState); bound to the browser that started it (a cookie whose
-- SHA-256 is binding_hash) and to the interaction (sign-in for an app) or the account
-- pages. user_id is set once the provider's answer is verified.
CREATE TABLE federation_requests (
  state         text        PRIMARY KEY,
  source_id     uuid        NOT NULL REFERENCES identity_sources (id) ON DELETE CASCADE,
  purpose       text        NOT NULL CHECK (purpose IN ('login', 'account')),
  interaction   text,
  binding_hash  bytea       NOT NULL CHECK (octet_length(binding_hash) = 32),
  nonce         text        NOT NULL,
  code_verifier text        NOT NULL,
  user_id       uuid        REFERENCES users (id) ON DELETE CASCADE,
  expires_at    timestamptz NOT NULL,
  CHECK ((purpose = 'login') = (interaction IS NOT NULL))
);
CREATE INDEX federation_requests_expires_at ON federation_requests (expires_at);

-- SAML AuthnRequest ids sent and not yet answered (InResponseTo is checked against them).
CREATE TABLE saml_request_ids (
  id         text        PRIMARY KEY,
  issued_at  text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX saml_request_ids_created_at ON saml_request_ids (created_at);

-- Down Migration

DROP TABLE saml_request_ids;
DROP TABLE federation_requests;
-- Accounts of identity providers become local accounts (sign-in by e-mail, a reset).
UPDATE users SET source_id = NULL, external_id = NULL
  WHERE source_id IN (SELECT id FROM identity_sources WHERE kind <> 'ldap');
DELETE FROM identity_sources WHERE kind <> 'ldap';
ALTER TABLE identity_sources DROP CONSTRAINT identity_sources_kind_check;
ALTER TABLE identity_sources
  ADD CONSTRAINT identity_sources_kind_check CHECK (kind IN ('ldap'));

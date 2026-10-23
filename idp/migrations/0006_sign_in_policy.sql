-- SPDX-License-Identifier: AGPL-3.0-only
-- Cenacle ID: the organization's sign-in policy (v0.29).

-- Up Migration

-- One row. By default two-step verification is required (people without it set it
-- up at their next sign-in) and passkeys are off; administrators change both in the
-- admin panel. Single sign-on providers are off until an administrator adds one.
CREATE TABLE sign_in_policy (
  id               boolean     PRIMARY KEY DEFAULT true CHECK (id),
  require_two_step boolean     NOT NULL DEFAULT true,
  passkeys         boolean     NOT NULL DEFAULT false,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
INSERT INTO sign_in_policy DEFAULT VALUES;

-- Down Migration

DROP TABLE sign_in_policy;

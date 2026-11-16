-- SPDX-License-Identifier: AGPL-3.0-only
-- Cenacle ID: the mail server it sends e-mail through (ADR 0057).

-- Up Migration

-- One row, set by administrators in the admin panel (IDP_SMTP_HOST overrides it).
-- An empty host: no e-mail. The password is sealed with IDP_KEY_ENCRYPTION_KEY.
CREATE TABLE mail_server (
  id           boolean     PRIMARY KEY DEFAULT true CHECK (id),
  host         text        NOT NULL DEFAULT '' CHECK (char_length(host) <= 253),
  port         integer     NOT NULL DEFAULT 587 CHECK (port BETWEEN 1 AND 65535),
  security     text        NOT NULL DEFAULT 'starttls' CHECK (security IN ('starttls', 'tls', 'none')),
  username     text        NOT NULL DEFAULT '' CHECK (char_length(username) <= 320),
  password_enc bytea,
  sender       text        NOT NULL DEFAULT '' CHECK (char_length(sender) <= 400),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
INSERT INTO mail_server DEFAULT VALUES;

-- Down Migration

DROP TABLE mail_server;

-- SPDX-License-Identifier: AGPL-3.0-only
-- Cenacle ID: accounts an administrator deleted.
--
-- Only the id and the time are kept, so the directory feed can tell the apps
-- (the chat) to deactivate the person and end their sessions, in the same
-- order as other changes.

-- Up Migration

CREATE TABLE deleted_accounts (
  id         uuid        PRIMARY KEY,
  deleted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deleted_accounts_feed ON deleted_accounts (deleted_at, id);

-- Down Migration

DROP TABLE deleted_accounts;

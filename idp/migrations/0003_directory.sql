-- SPDX-License-Identifier: Apache-2.0
-- Cenacle ID: directory accounts (LDAP / Active Directory), groups, sync runs,
-- administrators of Cenacle ID and account photos.

-- Up Migration

-- Where accounts come from besides local sign-up: a directory (LDAP, v0.14).
-- Settings are JSON; the bind password is encrypted (IDP_KEY_ENCRYPTION_KEY).
CREATE TABLE identity_sources (
  id                    uuid        PRIMARY KEY DEFAULT uuidv7(),
  kind                  text        NOT NULL CHECK (kind IN ('ldap')),
  name                  text        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  config                jsonb       NOT NULL,
  secret_enc            bytea,
  enabled               boolean     NOT NULL DEFAULT true,
  sync_interval_minutes integer     NOT NULL DEFAULT 60 CHECK (sync_interval_minutes BETWEEN 5 AND 10080),
  last_sync_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Directory accounts may have no e-mail address; NULL addresses are distinct.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users
  ADD COLUMN source_id   uuid REFERENCES identity_sources (id) ON DELETE RESTRICT,
  -- The directory's stable id (objectGUID, entryUUID): names and addresses change.
  ADD COLUMN external_id text,
  -- The sign-in name in the directory (sAMAccountName, uid, ...).
  ADD COLUMN username    citext UNIQUE,
  ADD COLUMN title       text,
  -- From the directory's admin and guest filters: 'admin', 'guest' or NULL.
  ADD COLUMN directory_role text CHECK (directory_role IN ('admin', 'guest')),
  -- Administers Cenacle ID (accounts, sign-in methods): the admin panel.
  ADD COLUMN is_admin    boolean NOT NULL DEFAULT false,
  ADD COLUMN synced_at   timestamptz,
  ADD CONSTRAINT users_source_external CHECK ((source_id IS NULL) = (external_id IS NULL));
CREATE UNIQUE INDEX users_source_external_id ON users (source_id, external_id) WHERE source_id IS NOT NULL;
CREATE INDEX users_updated_at ON users (updated_at, id);

-- Groups of a directory and who is in them (nested groups resolved).
CREATE TABLE directory_groups (
  id          uuid    PRIMARY KEY DEFAULT uuidv7(),
  source_id   uuid    NOT NULL REFERENCES identity_sources (id) ON DELETE CASCADE,
  external_id text    NOT NULL,
  name        text    NOT NULL,
  dn          text    NOT NULL DEFAULT '',
  UNIQUE (source_id, external_id)
);
CREATE TABLE user_groups (
  user_id  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES directory_groups (id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, group_id)
);
CREATE INDEX user_groups_group ON user_groups (group_id);

-- Every synchronization with a directory, for the admin panel's history.
CREATE TABLE sync_runs (
  id                uuid        PRIMARY KEY DEFAULT uuidv7(),
  source_id         uuid        NOT NULL REFERENCES identity_sources (id) ON DELETE CASCADE,
  trigger           text        NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  status            text        NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  users_seen        integer     NOT NULL DEFAULT 0,
  users_created     integer     NOT NULL DEFAULT 0,
  users_updated     integer     NOT NULL DEFAULT 0,
  users_deactivated integer     NOT NULL DEFAULT 0,
  groups            integer     NOT NULL DEFAULT 0,
  error             text        NOT NULL DEFAULT ''
);
CREATE INDEX sync_runs_source ON sync_runs (source_id, started_at DESC);

-- Account photos: from the directory (thumbnailPhoto, jpegPhoto) or uploaded by
-- the person (v0.15), which then wins.
CREATE TABLE user_photos (
  user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  origin       text        NOT NULL CHECK (origin IN ('directory', 'upload')),
  content_type text        NOT NULL,
  data         bytea       NOT NULL CHECK (octet_length(data) <= 2097152),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, origin)
);

-- Down Migration

DROP TABLE user_photos;
DROP TABLE sync_runs;
DROP TABLE user_groups;
DROP TABLE directory_groups;
DROP INDEX users_updated_at;
DROP INDEX users_source_external_id;
ALTER TABLE users
  DROP CONSTRAINT users_source_external,
  DROP COLUMN synced_at,
  DROP COLUMN is_admin,
  DROP COLUMN directory_role,
  DROP COLUMN title,
  DROP COLUMN username,
  DROP COLUMN external_id,
  DROP COLUMN source_id;
DELETE FROM users WHERE email IS NULL;
ALTER TABLE users ALTER COLUMN email SET NOT NULL;
DROP TABLE identity_sources;

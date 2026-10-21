-- SPDX-License-Identifier: Apache-2.0
--
-- Sessions remember the Cenacle ID sign-in they came from (back-channel logout), and
-- an audit log records security-relevant actions.

-- +goose Up
-- The IdP's session id ("sid" of the ID token); '' for sessions from before.
ALTER TABLE sessions ADD COLUMN idp_sid text NOT NULL DEFAULT '';
CREATE INDEX sessions_idp_sid_idx ON sessions (idp_sid) WHERE idp_sid <> '';

-- Who did what, when, to which object. Workspace events belong to their workspace;
-- account events (sessions) have none.
CREATE TABLE audit_events (
    id           uuid        PRIMARY KEY DEFAULT uuidv7(),
    at           timestamptz NOT NULL DEFAULT now(),
    actor_id     uuid        REFERENCES users (id) ON DELETE SET NULL,
    workspace_id uuid        REFERENCES workspaces (id) ON DELETE CASCADE,
    action       text        NOT NULL,
    target_type  text        NOT NULL DEFAULT '',
    target_id    text        NOT NULL DEFAULT '',
    ip_address   text        NOT NULL DEFAULT '',
    detail       jsonb       NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_events_workspace_idx ON audit_events (workspace_id, id DESC);
CREATE INDEX audit_events_actor_idx ON audit_events (actor_id, id DESC);

-- +goose Down
DROP TABLE audit_events;
DROP INDEX sessions_idp_sid_idx;
ALTER TABLE sessions DROP COLUMN idp_sid;

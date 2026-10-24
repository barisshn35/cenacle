-- +goose Up
-- Session and network policy (v0.35), set by installation administrators over
-- the operator's limits (CENACLE_SESSION_*): how long sessions last, for guests
-- separately, and which networks may sign in and use the administration.
-- 0 hours or minutes: no limit beyond the operator's; empty lists: everywhere.
ALTER TABLE instance_settings
    ADD COLUMN session_max_hours       integer NOT NULL DEFAULT 0 CHECK (session_max_hours BETWEEN 0 AND 87600),
    ADD COLUMN session_idle_minutes    integer NOT NULL DEFAULT 0 CHECK (session_idle_minutes BETWEEN 0 AND 525600),
    ADD COLUMN guest_session_max_hours integer NOT NULL DEFAULT 0 CHECK (guest_session_max_hours BETWEEN 0 AND 87600),
    ADD COLUMN guest_idle_minutes      integer NOT NULL DEFAULT 0 CHECK (guest_idle_minutes BETWEEN 0 AND 525600),
    ADD COLUMN admin_networks          text[]  NOT NULL DEFAULT '{}',
    ADD COLUMN signin_networks         text[]  NOT NULL DEFAULT '{}';

-- +goose Down
ALTER TABLE instance_settings
    DROP COLUMN signin_networks, DROP COLUMN admin_networks, DROP COLUMN guest_idle_minutes,
    DROP COLUMN guest_session_max_hours, DROP COLUMN session_idle_minutes, DROP COLUMN session_max_hours;

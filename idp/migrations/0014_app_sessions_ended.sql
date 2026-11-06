-- SPDX-License-Identifier: AGPL-3.0-only
-- Cenacle ID: ending a person's sessions ends them in the apps too.
--
-- The directory feed carries the time; an app (the chat) ends the sessions it
-- made before it, so a two-step reset also signs out a stolen device's chat.

-- Up Migration

ALTER TABLE users ADD COLUMN sessions_ended_at timestamptz;

-- Down Migration

ALTER TABLE users DROP COLUMN sessions_ended_at;

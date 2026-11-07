-- SPDX-License-Identifier: AGPL-3.0-only
-- Calls are on in a workspace unless its administrators turn them off (they
-- still need the installation's media service). Workspaces whose call settings
-- nobody has changed are turned on; one turned off on purpose stays off.

-- +goose Up
ALTER TABLE workspaces ALTER COLUMN calls_enabled SET DEFAULT true;
UPDATE workspaces w SET calls_enabled = true
WHERE NOT w.calls_enabled
  AND NOT EXISTS (
    SELECT 1 FROM audit_events a WHERE a.workspace_id = w.id AND a.action = 'call.settings_changed'
  );

-- +goose Down
ALTER TABLE workspaces ALTER COLUMN calls_enabled SET DEFAULT false;

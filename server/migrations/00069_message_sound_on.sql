-- +goose Up
-- Every message makes a sound by default. Until now other messages had none
-- by default, and saving the settings stored that "none" with the rest, so it
-- cannot be told from a choice: settings saved with it take the new default.
UPDATE notification_prefs
SET prefs = jsonb_set(prefs, '{sounds,message}', '"drop"'), updated_at = now()
WHERE prefs #>> '{sounds,message}' = 'none';

-- +goose Down
-- Which settings were changed is not kept; nothing to undo.

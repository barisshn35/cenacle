-- +goose Up
-- Call recording (ADR 0053): a workspace allows it; a call is recorded, for
-- everyone to see, by the app of the person who started it.
ALTER TABLE workspaces ADD COLUMN calls_recording boolean NOT NULL DEFAULT false;
ALTER TABLE calls
    ADD COLUMN recording_on boolean NOT NULL DEFAULT false,
    ADD COLUMN recording_by uuid REFERENCES users (id) ON DELETE SET NULL;

-- +goose Down
ALTER TABLE calls DROP COLUMN recording_by, DROP COLUMN recording_on;
ALTER TABLE workspaces DROP COLUMN calls_recording;

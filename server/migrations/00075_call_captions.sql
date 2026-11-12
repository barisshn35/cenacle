-- +goose Up
-- Live captions (ADR 0052): a workspace allows them; a call has them on since
-- someone turned them on (who, for everyone to see).
ALTER TABLE workspaces ADD COLUMN calls_captions boolean NOT NULL DEFAULT false;
ALTER TABLE calls
    ADD COLUMN captions_on boolean NOT NULL DEFAULT false,
    ADD COLUMN captions_by uuid REFERENCES users (id) ON DELETE SET NULL;

-- +goose Down
ALTER TABLE calls DROP COLUMN captions_by, DROP COLUMN captions_on;
ALTER TABLE workspaces DROP COLUMN calls_captions;

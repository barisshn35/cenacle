-- +goose Up
-- Call notes (ADR 0052): what was said while notes were on, line by line.
ALTER TABLE workspaces ADD COLUMN calls_notes boolean NOT NULL DEFAULT false;
ALTER TABLE calls
    ADD COLUMN notes_on boolean NOT NULL DEFAULT false,
    ADD COLUMN notes_by uuid REFERENCES users (id) ON DELETE SET NULL;
CREATE TABLE call_notes (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    call_id uuid NOT NULL REFERENCES calls (id) ON DELETE CASCADE,
    user_id uuid REFERENCES users (id) ON DELETE SET NULL,
    text text NOT NULL CHECK (char_length(text) <= 2000),
    said_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX call_notes_call ON call_notes (call_id, said_at);
CREATE INDEX call_notes_user ON call_notes (user_id) WHERE user_id IS NOT NULL;

-- +goose Down
DROP TABLE call_notes;
ALTER TABLE calls DROP COLUMN notes_by, DROP COLUMN notes_on;
ALTER TABLE workspaces DROP COLUMN calls_notes;

-- +goose Up
-- Archive exports (v0.36): a workspace's messages in formats archiving
-- systems ingest (CSV, Actiance XML, EML), on demand or every day into the
-- object store. archive_last_day is the last whole UTC day exported.
ALTER TABLE workspaces
    ADD COLUMN archive_format   text NOT NULL DEFAULT '' CHECK (archive_format IN ('', 'csv', 'actiance', 'eml')),
    ADD COLUMN archive_last_day date;
CREATE TABLE archive_exports (
    id           uuid        PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    format       text        NOT NULL CHECK (format IN ('csv', 'actiance', 'eml')),
    day          date        NOT NULL,
    object_key   text        NOT NULL,
    size         bigint      NOT NULL,
    messages     integer     NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, format, day)
);

-- +goose Down
DROP TABLE archive_exports;
ALTER TABLE workspaces DROP COLUMN archive_last_day, DROP COLUMN archive_format;

-- +goose Up
-- Data spillage (v0.36): someone reports that a message holds what must not be
-- here (classified, personal, secret); a designated reviewer removes it
-- everywhere or dismisses the report. The report keeps what happened (the
-- incident report), never the content.
ALTER TABLE workspaces ADD COLUMN spillage_reviewers uuid[] NOT NULL DEFAULT '{}';
CREATE TABLE spillage_reports (
    id            uuid        PRIMARY KEY DEFAULT uuidv7(),
    workspace_id  uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    channel_id    uuid        REFERENCES channels (id) ON DELETE SET NULL,
    message_id    uuid        REFERENCES messages (id) ON DELETE SET NULL,
    -- Kept when the message is gone (the incident report names it).
    message_ref   uuid        NOT NULL,
    reported_by   uuid        REFERENCES users (id) ON DELETE SET NULL,
    reason        text        NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 1000),
    status        text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'removed', 'dismissed')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    decided_by    uuid        REFERENCES users (id) ON DELETE SET NULL,
    decided_at    timestamptz,
    note          text        NOT NULL DEFAULT '' CHECK (char_length(note) <= 2000),
    report        jsonb       NOT NULL DEFAULT '{}'
);
CREATE INDEX spillage_reports_workspace_idx ON spillage_reports (workspace_id, status, id DESC);
CREATE UNIQUE INDEX spillage_reports_open_idx ON spillage_reports (message_ref) WHERE status = 'open';

-- +goose Down
DROP TABLE spillage_reports;
ALTER TABLE workspaces DROP COLUMN spillage_reviewers;

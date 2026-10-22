-- +goose Up
-- Optional AI: a workspace turns it on (off by default) when the operator
-- configured a model; requests are recorded for limits and usage.

ALTER TABLE workspaces ADD COLUMN ai_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE ai_requests (
    id           uuid        PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    user_id      uuid        REFERENCES users (id) ON DELETE SET NULL,
    kind         text        NOT NULL CHECK (kind IN ('summary', 'compose', 'ask')),
    input_chars  integer     NOT NULL,
    output_chars integer     NOT NULL DEFAULT 0,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_requests_user_idx ON ai_requests (user_id, created_at DESC);

-- +goose Down
DROP TABLE ai_requests;
ALTER TABLE workspaces DROP COLUMN ai_enabled;

-- +goose Up
-- The workspaces and channels an import created. An import adds people and
-- roles only to these unless the operator asks it to merge into existing ones
-- (an export's author must not be able to join a native private channel).
CREATE TABLE imported_workspaces (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE imported_channels (
  channel_id uuid PRIMARY KEY REFERENCES channels (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE imported_channels;
DROP TABLE imported_workspaces;

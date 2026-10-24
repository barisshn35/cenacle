-- +goose Up
-- Read receipts in conversations (v0.32): off unless a workspace's
-- administrators turn them on; each person can keep theirs to themselves
-- (and then sees no one else's either).
ALTER TABLE workspaces ADD COLUMN read_receipts boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN share_read_receipts boolean NOT NULL DEFAULT true;

-- +goose Down
ALTER TABLE users DROP COLUMN share_read_receipts;
ALTER TABLE workspaces DROP COLUMN read_receipts;

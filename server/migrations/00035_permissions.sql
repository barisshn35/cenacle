-- +goose Up
-- Permission schemes: which workspace roles may do what (owners always may),
-- over the defaults of 0.33. Channel moderation: who may post, answer in
-- threads, react and mention everyone in a channel.
ALTER TABLE workspaces ADD COLUMN permissions jsonb NOT NULL DEFAULT '{}';
ALTER TABLE channels ADD COLUMN moderation jsonb NOT NULL DEFAULT '{}';

-- +goose Down
ALTER TABLE channels DROP COLUMN moderation;
ALTER TABLE workspaces DROP COLUMN permissions;

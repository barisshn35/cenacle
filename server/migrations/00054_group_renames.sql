-- +goose Up
-- Group mappings follow the changes of the names Cenacle ID gives groups (ADR
-- 0046). A change the chat may not follow by itself (several groups had the
-- old name) leaves the mapping as it is with the new names as candidates for
-- its administrators to choose from.
ALTER TABLE workspace_group_mappings ADD COLUMN review_candidates text[] NOT NULL DEFAULT '{}';
ALTER TABLE channel_group_mappings ADD COLUMN review_candidates text[] NOT NULL DEFAULT '{}';

-- The last change of Cenacle ID's group-renames feed the chat applied.
CREATE TABLE group_rename_state (
    id     boolean PRIMARY KEY DEFAULT true CHECK (id),
    cursor bigint  NOT NULL DEFAULT 0
);
INSERT INTO group_rename_state (id) VALUES (true);

-- +goose Down
DROP TABLE group_rename_state;
ALTER TABLE channel_group_mappings DROP COLUMN review_candidates;
ALTER TABLE workspace_group_mappings DROP COLUMN review_candidates;

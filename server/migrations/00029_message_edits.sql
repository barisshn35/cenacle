-- +goose Up
-- Earlier versions of edited messages (v0.31). Each edit keeps the text it
-- replaced, with when that text was written; they go with their message (as
-- it is purged, by retention or after deletion) and into eDiscovery exports.
CREATE TABLE message_edits (
    id          uuid        PRIMARY KEY DEFAULT uuidv7(),
    message_id  uuid        NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    body        text        NOT NULL,
    written_at  timestamptz NOT NULL,
    replaced_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_edits_message_idx ON message_edits (message_id, id);

-- Who sees a message's earlier versions: its author, or everyone who sees it.
ALTER TABLE workspaces
    ADD COLUMN edit_history text NOT NULL DEFAULT 'author' CHECK (edit_history IN ('author', 'everyone'));

-- +goose Down
ALTER TABLE workspaces DROP COLUMN edit_history;
DROP TABLE message_edits;

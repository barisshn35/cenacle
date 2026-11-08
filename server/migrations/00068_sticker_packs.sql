-- +goose Up
-- Sticker packs: a named set of stickers (often animated GIFs) added at once.
CREATE TABLE sticker_packs (
    id           uuid        PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    name         text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
    created_by   uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sticker_packs_workspace_idx ON sticker_packs (workspace_id, created_at);

ALTER TABLE stickers
    ADD COLUMN pack_id    uuid REFERENCES sticker_packs (id) ON DELETE SET NULL,
    -- A removed sticker some message shows stays for that message, out of the picker.
    ADD COLUMN removed_at timestamptz;
CREATE INDEX stickers_pack_idx ON stickers (pack_id) WHERE pack_id IS NOT NULL;
-- Which messages show a sticker (removing one asks).
CREATE INDEX messages_sticker_idx ON messages (sticker_id) WHERE sticker_id IS NOT NULL;

-- +goose Down
DROP INDEX messages_sticker_idx;
DELETE FROM stickers WHERE removed_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.sticker_id = stickers.id);
ALTER TABLE stickers DROP COLUMN removed_at, DROP COLUMN pack_id;
DROP TABLE sticker_packs;

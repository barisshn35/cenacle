-- +goose Up
-- Search inside files, canvases and lists (v0.37). The text of files is read
-- by a background job (PDF, Office, OpenDocument, plain text) and kept with
-- the file: pending until read, done, or none (no text to read).
ALTER TABLE files
    ADD COLUMN content_text  text CHECK (content_text IS NULL OR char_length(content_text) <= 200000),
    ADD COLUMN content_state text NOT NULL DEFAULT 'pending' CHECK (content_state IN ('pending', 'done', 'none'));
CREATE INDEX files_content_search_idx ON files USING gin (cenacle_search_vector(content_text))
    WHERE content_text IS NOT NULL;
CREATE INDEX files_content_pending_idx ON files (id) WHERE content_state = 'pending' AND status = 'ready';
CREATE INDEX canvases_search_idx ON canvases USING gin (cenacle_search_vector(body));
CREATE INDEX list_items_search_idx ON list_items USING gin (cenacle_search_vector(title || ' ' || "values"::text));

-- +goose Down
DROP INDEX list_items_search_idx;
DROP INDEX canvases_search_idx;
DROP INDEX files_content_pending_idx;
DROP INDEX files_content_search_idx;
ALTER TABLE files DROP COLUMN content_state, DROP COLUMN content_text;

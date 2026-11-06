-- +goose NO TRANSACTION
-- +goose Up
-- A search for a rare word read every message on a large server (40 s with two
-- million messages, past the server's 30-second limit, so nothing came back).
-- The search indexes of messages and of file texts are partial (not deleted, has
-- text), and PostgreSQL keeps no statistics for the expression of a partial index:
-- it took every word for a common one and walked the messages newest first.
-- Statistics on the expression give it the real counts. New messages also go into
-- the index at once instead of a pending list, which until the next vacuum made the
-- index look slow and the planner walk the messages again. The indexes and the
-- stored rows stay as they are.
--
-- No transaction: the statistics are filled before the index is changed, so the
-- index is locked for a moment only, not for the time ANALYZE reads the tables.
-- Every step can run again.
CREATE STATISTICS IF NOT EXISTS messages_search_stats ON (cenacle_search_vector(body)) FROM messages;
CREATE STATISTICS IF NOT EXISTS files_content_search_stats ON (cenacle_search_vector(content_text)) FROM files;
ANALYZE messages;
ANALYZE files;
-- Changing the index waits for every query that uses it, and new messages would
-- wait behind it (a slow search of an older server takes up to 40 s): so it waits
-- at most 200 ms at a time and tries again, for up to five minutes.
-- +goose StatementBegin
DO $$
BEGIN
    FOR attempt IN 1..600 LOOP
        BEGIN
            PERFORM set_config('lock_timeout', '200ms', true);
            ALTER INDEX messages_search_idx SET (fastupdate = off);
            RETURN;
        EXCEPTION WHEN lock_not_available THEN
            PERFORM pg_sleep(0.3);
        END;
    END LOOP;
    RAISE EXCEPTION 'messages_search_idx stayed in use for five minutes; run the migration again';
END
$$;
-- +goose StatementEnd
-- Entries already pending move into the index.
SELECT gin_clean_pending_list('messages_search_idx');

-- +goose Down
ALTER INDEX messages_search_idx RESET (fastupdate);
DROP STATISTICS IF EXISTS files_content_search_stats;
DROP STATISTICS IF EXISTS messages_search_stats;

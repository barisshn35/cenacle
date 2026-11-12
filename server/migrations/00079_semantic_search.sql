-- +goose Up
-- Semantic search (ADR 0055): the state of the message vectors and the queue
-- of messages to index. The vector table itself follows the model's width and
-- is made by the server (message_vectors).
CREATE TABLE semantic_index (
    id         boolean PRIMARY KEY DEFAULT true CHECK (id),
    -- On while the vectors are kept: written and edited messages are queued.
    enabled    boolean NOT NULL DEFAULT false,
    model      text NOT NULL DEFAULT '',
    dims       integer NOT NULL DEFAULT 0,
    built_at   timestamptz
);
INSERT INTO semantic_index DEFAULT VALUES;

CREATE TABLE embedding_queue (
    message_id uuid PRIMARY KEY,
    queued_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX embedding_queue_order ON embedding_queue (queued_at);

-- +goose StatementBegin
CREATE FUNCTION cenacle_queue_embedding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (SELECT enabled FROM semantic_index) THEN
        INSERT INTO embedding_queue (message_id) VALUES (NEW.id)
        ON CONFLICT (message_id) DO UPDATE SET queued_at = now();
    END IF;
    RETURN NULL;
END
$$;
-- +goose StatementEnd

CREATE TRIGGER messages_queue_embedding
    AFTER INSERT OR UPDATE OF body, deleted_at ON messages
    FOR EACH ROW EXECUTE FUNCTION cenacle_queue_embedding();

-- +goose Down
DROP TRIGGER messages_queue_embedding ON messages;
DROP FUNCTION cenacle_queue_embedding();
DROP TABLE IF EXISTS message_vectors;
DROP TABLE embedding_queue;
DROP TABLE semantic_index;

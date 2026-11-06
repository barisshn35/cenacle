-- +goose Up
-- A file search for a rare word, or for a word in no file, ran into the 10-second
-- limit on a large server (200,000 files of 80 words): PostgreSQL took making the
-- words of a text for almost free, so it read the files newest first and made the
-- words of each one instead of looking the word up in the index. The function is
-- the same; it now says what it costs, and its SET clause keeps PostgreSQL from
-- copying its body into the query, which would drop that cost again. Nothing is
-- rebuilt: the indexes, the statistics and the stored rows stay as they are.
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION cenacle_search_vector(body text) RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE COST 10000
SET search_path = pg_catalog, public AS $$
    SELECT to_tsvector('simple'::regconfig,
        public.unaccent('public.unaccent'::regdictionary, lower(translate(body, 'İIı', 'iii'))))
$$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION cenacle_search_vector(body text) RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT to_tsvector('simple'::regconfig,
        public.unaccent('public.unaccent'::regdictionary, lower(translate(body, 'İIı', 'iii'))))
$$;
-- +goose StatementEnd

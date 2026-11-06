-- +goose Up
-- A search word with a hyphen or an apostrophe ("e-mail", "load-5", "İstanbul'da")
-- found nothing: the query squeezed it to one word ("email:*") while the text is
-- stored in parts ('e-mail', 'e', 'mail'; 'load', '-5'; 'istanbul', 'da'). Now
-- the word is split by the same parser that splits the text, and every part must
-- start a word of the text; the squeezed word still matches as before, so no
-- search finds less than it did. The indexes and the stored text stay as they are.
-- +goose StatementBegin
-- One word as a prefix in tsquery syntax, quoted so that it is taken as it is.
CREATE FUNCTION cenacle_search_prefix(lexeme text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT '''' || replace(replace(lexeme, '\', '\\'), '''', '''''') || ''':*'
$$;
CREATE OR REPLACE FUNCTION cenacle_search_query(q text) RETURNS tsquery
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT string_agg(
        CASE WHEN w.negated THEN '!' ELSE '' END || '(' || p.parts
            || CASE WHEN w.squeezed <> '' AND p.parts <> cenacle_search_prefix(w.squeezed)
                    THEN ' | ' || cenacle_search_prefix(w.squeezed) ELSE '' END || ')',
        ' & ')::tsquery
    FROM (
        SELECT left(t, 1) = '-' AS negated,
               CASE WHEN left(t, 1) = '-' THEN substr(t, 2) ELSE t END AS word,
               regexp_replace(t, '[^a-z0-9]', '', 'g') AS squeezed
        FROM regexp_split_to_table(
            public.unaccent('public.unaccent'::regdictionary, lower(translate(q, 'İIı', 'iii'))), '[\s]+') AS t
    ) AS w
    CROSS JOIN LATERAL (
        SELECT string_agg(cenacle_search_prefix(lexeme), ' & ') AS parts
        FROM unnest(tsvector_to_array(to_tsvector('simple'::regconfig, w.word))) AS lexeme
    ) AS p
    WHERE p.parts IS NOT NULL
$$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION cenacle_search_query(q text) RETURNS tsquery
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT to_tsquery('simple'::regconfig, string_agg(
        CASE WHEN left(w, 1) = '-' THEN '!' ELSE '' END || regexp_replace(w, '[^a-z0-9]', '', 'g') || ':*',
        ' & '))
    FROM regexp_split_to_table(
        public.unaccent('public.unaccent'::regdictionary, lower(translate(q, 'İIı', 'iii'))), '[\s]+') AS w
    WHERE regexp_replace(w, '[^a-z0-9]', '', 'g') <> ''
$$;
-- +goose StatementEnd
DROP FUNCTION cenacle_search_prefix(text);

-- +goose Up
-- Search (PostgreSQL full-text search that ignores accents and case) and
-- notifications: preferences, muting, quiet hours, sounds, e-mail and web push.

-- unaccent is a trusted extension: the database owner may create it.
CREATE EXTENSION IF NOT EXISTS unaccent SCHEMA public;

-- The words of a text for searching: lower case, Turkish dotless/dotted i folded,
-- accents removed. Wrapped as IMMUTABLE (unaccent with an explicit dictionary is
-- stable in practice) so it can feed a generated column.
-- +goose StatementBegin
CREATE FUNCTION cenacle_search_vector(body text) RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT to_tsvector('simple'::regconfig,
        public.unaccent('public.unaccent'::regdictionary, lower(translate(body, 'İIı', 'iii'))))
$$;
-- A search: every word must start a word of the text (Turkish suffixes: "istanbul"
-- finds "İstanbul'da"); "-word" excludes. NULL when nothing searchable is left.
CREATE FUNCTION cenacle_search_query(q text) RETURNS tsquery
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT to_tsquery('simple'::regconfig, string_agg(
        CASE WHEN left(w, 1) = '-' THEN '!' ELSE '' END || regexp_replace(w, '[^a-z0-9]', '', 'g') || ':*',
        ' & '))
    FROM regexp_split_to_table(
        public.unaccent('public.unaccent'::regdictionary, lower(translate(q, 'İIı', 'iii'))), '[\s]+') AS w
    WHERE regexp_replace(w, '[^a-z0-9]', '', 'g') <> ''
$$;
-- +goose StatementEnd

-- Expression indexes (no stored column: rows stay as they are, queries that read
-- whole rows do not carry the vector). Searches use the same expression.
CREATE INDEX messages_search_idx ON messages USING gin (cenacle_search_vector(body))
    WHERE deleted_at IS NULL;
CREATE INDEX files_search_idx ON files USING gin (cenacle_search_vector(name));

-- A person's notification settings (sounds, desktop, e-mail, pause, quiet hours).
CREATE TABLE notification_prefs (
    user_id    uuid        PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    prefs      jsonb       NOT NULL DEFAULT '{}',
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Per channel (and conversation): what notifies, muting, a sound of its own.
CREATE TABLE channel_notification_prefs (
    user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    channel_id  uuid        NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    level       text        NOT NULL DEFAULT 'default' CHECK (level IN ('default', 'all', 'mentions', 'none')),
    -- Muted (no notifications, unread shown quietly) until then; 'infinity' for good.
    muted_until timestamptz,
    sound       text        NOT NULL DEFAULT '' CHECK (char_length(sound) <= 64),
    PRIMARY KEY (user_id, channel_id)
);

CREATE TABLE workspace_notification_prefs (
    user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    workspace_id uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    muted_until  timestamptz,
    PRIMARY KEY (user_id, workspace_id)
);

-- Sounds people upload for themselves.
CREATE TABLE user_sounds (
    id           uuid        PRIMARY KEY DEFAULT uuidv7(),
    user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name         text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
    content_type text        NOT NULL CHECK (content_type IN ('audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm')),
    data         bytea       NOT NULL CHECK (octet_length(data) <= 1024 * 1024),
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_sounds_user_idx ON user_sounds (user_id, created_at);

-- E-mail about missed mentions and direct messages: the newest message already told.
CREATE TABLE email_notifications (
    user_id      uuid        PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    last_message uuid,
    sent_at      timestamptz
);

-- Web push subscriptions of a person's browsers.
CREATE TABLE push_subscriptions (
    id         uuid        PRIMARY KEY DEFAULT uuidv7(),
    user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    endpoint   text        NOT NULL UNIQUE CHECK (char_length(endpoint) <= 2000),
    p256dh     text        NOT NULL,
    auth       text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);

-- The server's VAPID key pair for web push (created on first use).
CREATE TABLE push_keys (
    id          boolean     PRIMARY KEY DEFAULT true CHECK (id),
    public_key  text        NOT NULL,
    private_key text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- How far the notification jobs (web push) have looked at new messages.
CREATE TABLE notify_cursors (
    name   text PRIMARY KEY,
    cursor uuid NOT NULL
);

-- +goose Down
DROP TABLE notify_cursors;
DROP TABLE push_keys;
DROP TABLE push_subscriptions;
DROP TABLE email_notifications;
DROP TABLE user_sounds;
DROP TABLE workspace_notification_prefs;
DROP TABLE channel_notification_prefs;
DROP TABLE notification_prefs;
DROP INDEX files_search_idx;
DROP INDEX messages_search_idx;
DROP FUNCTION cenacle_search_query(text);
DROP FUNCTION cenacle_search_vector(text);

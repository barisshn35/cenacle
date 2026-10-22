-- +goose Up
-- Profiles: pictures, @usernames, local time, custom status, last seen; a
-- description and an icon for workspaces.

-- Profile pictures and workspace icons. A new picture gets a new id, so its URL
-- can be cached for good. data is what was uploaded (a GIF keeps its frames) or
-- a re-encoded square PNG; still is a PNG of the first frame (shown when motion
-- is reduced) for animated pictures.
CREATE TABLE pictures (
    id           uuid        PRIMARY KEY DEFAULT uuidv7(),
    content_type text        NOT NULL CHECK (content_type IN ('image/png', 'image/gif')),
    data         bytea       NOT NULL CHECK (octet_length(data) <= 2 * 1024 * 1024),
    still        bytea       CHECK (still IS NULL OR octet_length(still) <= 1024 * 1024),
    created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users
    ADD COLUMN avatar_id         uuid REFERENCES pictures (id) ON DELETE SET NULL,
    -- The picture came from the directory (replaced when the directory's changes,
    -- never over one the person chose).
    ADD COLUMN avatar_from_directory boolean NOT NULL DEFAULT false,
    ADD COLUMN directory_photo   text NOT NULL DEFAULT '',
    -- IANA time zone ('' until the app reports the browser's).
    ADD COLUMN timezone          text NOT NULL DEFAULT '' CHECK (char_length(timezone) <= 64),
    ADD COLUMN show_last_seen    boolean NOT NULL DEFAULT true,
    ADD COLUMN last_seen_at      timestamptz,
    ADD COLUMN status_emoji      text NOT NULL DEFAULT '' CHECK (char_length(status_emoji) <= 64),
    ADD COLUMN status_text       text NOT NULL DEFAULT '' CHECK (char_length(status_text) <= 100),
    ADD COLUMN status_expires_at timestamptz,
    -- The last custom statuses used: [{"emoji": "…", "text": "…"}], newest first.
    ADD COLUMN recent_statuses   jsonb NOT NULL DEFAULT '[]',
    -- The @username is the directory's sign-in name: people cannot change it.
    ADD COLUMN username_from_directory boolean NOT NULL DEFAULT false;
UPDATE users SET username_from_directory = true WHERE username IS NOT NULL;
CREATE INDEX users_status_expires_idx ON users (status_expires_at) WHERE status_expires_at IS NOT NULL;

ALTER TABLE workspaces
    ADD COLUMN description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
    ADD COLUMN icon_id     uuid REFERENCES pictures (id) ON DELETE SET NULL;

-- The base of a generated @username: the address before the @ (or the name),
-- lower case, Turkish letters folded, only a-z, 0-9, dot, dash and underscore.
-- +goose StatementBegin
CREATE FUNCTION cenacle_username_base(email text, display_name text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
    SELECT coalesce(nullif(left(btrim(regexp_replace(
        translate(lower(CASE WHEN email <> '' THEN split_part(email, '@', 1) ELSE display_name END),
                  'çğıöşüâîûéèáàñ', 'cgiosuaiueeaan'),
        '[^a-z0-9._-]+', '', 'g'), '._-'), 24), ''), 'user')
$$;
-- +goose StatementEnd

-- Everyone gets a @username (directory accounts keep theirs).
-- +goose StatementBegin
DO $$
DECLARE
    r record;
    base text;
    candidate text;
BEGIN
    FOR r IN SELECT id, email, display_name FROM users WHERE username IS NULL ORDER BY created_at, id LOOP
        base := cenacle_username_base(r.email, r.display_name);
        candidate := base;
        WHILE EXISTS (SELECT 1 FROM users WHERE lower(username) = candidate) LOOP
            candidate := base || '-' || substr(md5(random()::text), 1, 4);
        END LOOP;
        UPDATE users SET username = candidate WHERE id = r.id;
    END LOOP;
END
$$;
-- +goose StatementEnd
-- Directory names that collide (case only) keep the first; the others get a suffix.
UPDATE users u SET username = u.username || '-' || substr(md5(u.id::text), 1, 4)
FROM (SELECT id, row_number() OVER (PARTITION BY lower(username) ORDER BY created_at, id) AS n
      FROM users WHERE username IS NOT NULL) d
WHERE u.id = d.id AND d.n > 1;
CREATE UNIQUE INDEX users_username_idx ON users (lower(username));

-- +goose Down
DROP INDEX users_username_idx;
DROP FUNCTION cenacle_username_base(text, text);
ALTER TABLE workspaces DROP COLUMN icon_id, DROP COLUMN description;
DROP INDEX users_status_expires_idx;
ALTER TABLE users
    DROP COLUMN username_from_directory,
    DROP COLUMN recent_statuses,
    DROP COLUMN status_expires_at,
    DROP COLUMN status_text,
    DROP COLUMN status_emoji,
    DROP COLUMN last_seen_at,
    DROP COLUMN show_last_seen,
    DROP COLUMN timezone,
    DROP COLUMN directory_photo,
    DROP COLUMN avatar_from_directory,
    DROP COLUMN avatar_id;
DROP TABLE pictures;

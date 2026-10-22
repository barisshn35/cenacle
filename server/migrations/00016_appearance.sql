-- +goose Up
-- Appearance: personal preferences (theme, fonts, code blocks), a workspace's
-- defaults, fonts people upload for themselves and interface texts the
-- administrators adapt.

-- What a person chose; the app validates and fills in defaults.
CREATE TABLE user_preferences (
    user_id    uuid        PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    appearance jsonb       NOT NULL DEFAULT '{}',
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- A workspace's default theme preset and font template.
ALTER TABLE workspaces ADD COLUMN appearance jsonb NOT NULL DEFAULT '{}';

-- Fonts people upload for themselves (only they get them).
CREATE TABLE user_fonts (
    id         uuid        PRIMARY KEY DEFAULT uuidv7(),
    user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name       text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
    format     text        NOT NULL CHECK (format IN ('woff2', 'woff', 'truetype', 'opentype')),
    data       bytea       NOT NULL CHECK (octet_length(data) <= 2 * 1024 * 1024),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_fonts_user_idx ON user_fonts (user_id, created_at);

-- Interface texts the instance administrators replaced, per language.
CREATE TABLE ui_texts (
    key        text        NOT NULL CHECK (char_length(key) <= 100),
    locale     text        NOT NULL CHECK (locale IN ('en', 'tr')),
    value      text        NOT NULL CHECK (char_length(value) BETWEEN 1 AND 500),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (key, locale)
);

-- +goose Down
DROP TABLE ui_texts;
DROP TABLE user_fonts;
ALTER TABLE workspaces DROP COLUMN appearance;
DROP TABLE user_preferences;

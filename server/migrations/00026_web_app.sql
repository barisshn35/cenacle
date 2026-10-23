-- +goose Up
-- Settings of the whole server (v0.29), one row: whether people may use
-- Cenacle in web browsers. Administrators can turn the web app off; the
-- desktop and mobile apps always work. CENACLE_WEB_APP overrides it.
CREATE TABLE instance_settings (
    id         boolean     PRIMARY KEY DEFAULT true CHECK (id),
    web_app    boolean     NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO instance_settings DEFAULT VALUES;

-- +goose Down
DROP TABLE instance_settings;

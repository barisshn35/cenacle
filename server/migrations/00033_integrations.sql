-- +goose Up
-- More built-in integrations (v0.33): GitHub and e-mail webhooks, and feeds
-- (RSS, Atom) a channel follows.
ALTER TABLE incoming_webhooks DROP CONSTRAINT incoming_webhooks_kind_check;
ALTER TABLE incoming_webhooks ADD CONSTRAINT incoming_webhooks_kind_check
    CHECK (kind IN ('generic', 'jira', 'gitlab', 'alertmanager', 'github', 'email'));

CREATE TABLE channel_feeds (
    id              uuid        PRIMARY KEY DEFAULT uuidv7(),
    channel_id      uuid        NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    url             text        NOT NULL CHECK (char_length(url) <= 2000),
    title           text        NOT NULL DEFAULT '' CHECK (char_length(title) <= 200),
    -- Items already seen (their guid or link), newest last, at most 200.
    seen            text[]      NOT NULL DEFAULT '{}',
    etag            text        NOT NULL DEFAULT '',
    last_modified   text        NOT NULL DEFAULT '',
    checked_at      timestamptz,
    failures        integer     NOT NULL DEFAULT 0,
    last_error      text        NOT NULL DEFAULT '',
    created_by      uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (channel_id, url)
);

-- +goose Down
DROP TABLE channel_feeds;
DELETE FROM incoming_webhooks WHERE kind IN ('github', 'email');
ALTER TABLE incoming_webhooks DROP CONSTRAINT incoming_webhooks_kind_check;
ALTER TABLE incoming_webhooks ADD CONSTRAINT incoming_webhooks_kind_check
    CHECK (kind IN ('generic', 'jira', 'gitlab', 'alertmanager'));

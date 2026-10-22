-- +goose Up
-- Collaboration: tabs of a channel next to its messages. A tab is a canvas
-- (a document written together), a list (rows with typed columns, also shown
-- as a board) or a link.

-- A canvas: Markdown edited by one person at a time (editing_by holds the
-- turn until editing_until); version guards against overwriting a change.
CREATE TABLE canvases (
    id            uuid        PRIMARY KEY DEFAULT uuidv7(),
    channel_id    uuid        NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    body          text        NOT NULL DEFAULT '' CHECK (char_length(body) <= 50000),
    version       integer     NOT NULL DEFAULT 1,
    updated_by    uuid        REFERENCES users (id) ON DELETE SET NULL,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    editing_by    uuid        REFERENCES users (id) ON DELETE SET NULL,
    editing_until timestamptz
);

-- A list: its columns, and the column its board groups by.
CREATE TABLE lists (
    id           uuid        PRIMARY KEY DEFAULT uuidv7(),
    channel_id   uuid        NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    -- [{"id", "name", "kind", "options"}]
    columns      jsonb       NOT NULL DEFAULT '[]',
    board_column text,
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- A row of a list. assignees, done and due repeat what its person, status and
-- first date columns hold, so "assigned to me" is one indexed query.
CREATE TABLE list_items (
    id         uuid             PRIMARY KEY DEFAULT uuidv7(),
    list_id    uuid             NOT NULL REFERENCES lists (id) ON DELETE CASCADE,
    title      text             NOT NULL CHECK (char_length(title) BETWEEN 1 AND 500),
    -- {"<column id>": "<value>"}
    "values"   jsonb            NOT NULL DEFAULT '{}',
    position   double precision NOT NULL,
    assignees  uuid[]           NOT NULL DEFAULT '{}',
    done       boolean          NOT NULL DEFAULT false,
    due        date,
    created_by uuid             REFERENCES users (id) ON DELETE SET NULL,
    created_at timestamptz      NOT NULL DEFAULT now(),
    updated_at timestamptz      NOT NULL DEFAULT now()
);
CREATE INDEX list_items_list_idx ON list_items (list_id, position);
CREATE INDEX list_items_assignees_idx ON list_items USING gin (assignees) WHERE NOT done;

-- The tabs of a channel, in order.
CREATE TABLE channel_tabs (
    id         uuid        PRIMARY KEY DEFAULT uuidv7(),
    channel_id uuid        NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    kind       text        NOT NULL CHECK (kind IN ('canvas', 'list', 'link')),
    title      text        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
    url        text        CHECK (char_length(url) <= 2000),
    canvas_id  uuid        UNIQUE REFERENCES canvases (id) ON DELETE CASCADE,
    list_id    uuid        UNIQUE REFERENCES lists (id) ON DELETE CASCADE,
    position   integer     NOT NULL,
    created_by uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((kind = 'canvas') = (canvas_id IS NOT NULL)),
    CHECK ((kind = 'list') = (list_id IS NOT NULL)),
    CHECK ((kind = 'link') = (url IS NOT NULL))
);
CREATE INDEX channel_tabs_channel_idx ON channel_tabs (channel_id, position);

-- +goose Down
DROP TABLE channel_tabs;
DROP TABLE list_items;
DROP TABLE lists;
DROP TABLE canvases;

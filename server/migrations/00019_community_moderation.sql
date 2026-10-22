-- +goose Up
-- Community and moderation: forum channels, polls, events, slow mode and
-- timeouts, AutoMod and reports, onboarding, playbooks, the announcement
-- banner and terms of service.

-- Forum channels: every post (a thread's first message) has a title and may
-- carry tags from the channel's list.
ALTER TABLE channels DROP CONSTRAINT channels_kind_check;
ALTER TABLE channels ADD CONSTRAINT channels_kind_check
    CHECK (kind IN ('standard', 'announcement', 'direct', 'group', 'forum'));
ALTER TABLE channels
    ADD COLUMN forum_tags text[] NOT NULL DEFAULT '{}' CHECK (cardinality(forum_tags) <= 20),
    -- Seconds a member waits between messages (managers are exempt); 0: off.
    ADD COLUMN slow_mode_seconds integer NOT NULL DEFAULT 0 CHECK (slow_mode_seconds BETWEEN 0 AND 21600);
ALTER TABLE messages
    ADD COLUMN title text CHECK (char_length(title) BETWEEN 1 AND 200),
    ADD COLUMN tags text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 5);
-- Slow mode looks at a member's latest message in a channel.
CREATE INDEX messages_channel_author_idx ON messages (channel_id, author_id, id DESC);

-- Polls: a message with a question and options.
CREATE TABLE polls (
    message_id uuid        PRIMARY KEY REFERENCES messages (id) ON DELETE CASCADE,
    multiple   boolean     NOT NULL DEFAULT false,
    anonymous  boolean     NOT NULL DEFAULT false,
    closes_at  timestamptz,
    closed_at  timestamptz
);
CREATE TABLE poll_options (
    id         uuid    PRIMARY KEY DEFAULT uuidv7(),
    message_id uuid    NOT NULL REFERENCES polls (message_id) ON DELETE CASCADE,
    position   integer NOT NULL,
    text       text    NOT NULL CHECK (char_length(text) BETWEEN 1 AND 200),
    UNIQUE (message_id, position)
);
CREATE TABLE poll_votes (
    option_id  uuid        NOT NULL REFERENCES poll_options (id) ON DELETE CASCADE,
    message_id uuid        NOT NULL REFERENCES polls (message_id) ON DELETE CASCADE,
    user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (option_id, user_id)
);
CREATE INDEX poll_votes_message_idx ON poll_votes (message_id, user_id);

-- Events of a workspace (optionally in a channel) and who comes.
CREATE TABLE events (
    id           uuid        PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    channel_id   uuid        REFERENCES channels (id) ON DELETE SET NULL,
    title        text        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
    description  text        NOT NULL DEFAULT '' CHECK (char_length(description) <= 4000),
    location     text        NOT NULL DEFAULT '' CHECK (char_length(location) <= 300),
    starts_at    timestamptz NOT NULL,
    ends_at      timestamptz NOT NULL CHECK (ends_at > starts_at),
    created_by   uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    canceled_at  timestamptz
);
CREATE INDEX events_workspace_idx ON events (workspace_id, starts_at);
CREATE TABLE event_rsvps (
    event_id    uuid        NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    status      text        NOT NULL CHECK (status IN ('going', 'maybe', 'declined')),
    -- The reminder before the event (a scheduled message from the system bot).
    reminder_id uuid        REFERENCES scheduled_messages (id) ON DELETE SET NULL,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, user_id)
);

-- Timeouts: a member who may not post or react in the workspace until then.
-- Onboarding: when the member saw the workspace's welcome.
ALTER TABLE workspace_members
    ADD COLUMN timeout_until timestamptz,
    ADD COLUMN onboarded_at  timestamptz;
-- The welcome a workspace shows new members: a message, rules and channels to join.
ALTER TABLE workspaces
    ADD COLUMN welcome jsonb NOT NULL DEFAULT '{}';

-- AutoMod rules of a workspace.
CREATE TABLE automod_rules (
    id            uuid        PRIMARY KEY DEFAULT uuidv7(),
    workspace_id  uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    name          text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    kind          text        NOT NULL CHECK (kind IN ('keywords', 'mentions', 'links')),
    -- keywords: {"words": [...]}; mentions: {"max": n}; links: {"allow": [domains]}.
    config        jsonb       NOT NULL DEFAULT '{}',
    action        text        NOT NULL CHECK (action IN ('block', 'flag')),
    -- Workspace roles the rule does not apply to.
    exempt_roles  text[]      NOT NULL DEFAULT '{owner,admin}',
    enabled       boolean     NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX automod_rules_workspace_idx ON automod_rules (workspace_id) WHERE enabled;

-- Reports of messages (by people, or flags of AutoMod) for the workspace's moderators.
CREATE TABLE message_reports (
    id           uuid        PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    message_id   uuid        NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    -- NULL: AutoMod (rule_name says which rule).
    reporter_id  uuid        REFERENCES users (id) ON DELETE SET NULL,
    rule_name    text        NOT NULL DEFAULT '',
    reason       text        NOT NULL DEFAULT '' CHECK (char_length(reason) <= 1000),
    status       text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
    action       text        NOT NULL DEFAULT '' CHECK (action IN ('', 'deleted', 'timeout', 'none')),
    resolved_by  uuid        REFERENCES users (id) ON DELETE SET NULL,
    resolved_at  timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_reports_queue_idx ON message_reports (workspace_id, status, created_at DESC);
-- One open report per person and message.
CREATE UNIQUE INDEX message_reports_once_idx ON message_reports (message_id, reporter_id) WHERE status = 'open';

-- Playbooks: checklists a team runs again and again; a run follows one in a channel.
CREATE TABLE playbooks (
    id           uuid        PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    name         text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
    description  text        NOT NULL DEFAULT '' CHECK (char_length(description) <= 4000),
    -- [{"title": "...", "items": [{"title": "...", "description": "..."}]}]
    checklists   jsonb       NOT NULL DEFAULT '[]',
    created_by   uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    archived_at  timestamptz
);
CREATE INDEX playbooks_workspace_idx ON playbooks (workspace_id) WHERE archived_at IS NULL;
CREATE TABLE playbook_runs (
    id           uuid        PRIMARY KEY DEFAULT uuidv7(),
    playbook_id  uuid        REFERENCES playbooks (id) ON DELETE SET NULL,
    workspace_id uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    channel_id   uuid        NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    name         text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
    owner_id     uuid        REFERENCES users (id) ON DELETE SET NULL,
    -- The playbook's checklists as copied when the run started, with each
    -- item's state: {"done_by", "done_at", "assignee_id", "skipped"}.
    checklists   jsonb       NOT NULL DEFAULT '[]',
    status       text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'finished')),
    created_at   timestamptz NOT NULL DEFAULT now(),
    finished_at  timestamptz
);
CREATE INDEX playbook_runs_channel_idx ON playbook_runs (channel_id, created_at DESC);
CREATE INDEX playbook_runs_workspace_idx ON playbook_runs (workspace_id, status, created_at DESC);

-- Instance-wide: the announcement banner and the terms of service. A version
-- of the terms people must accept before using Cenacle; NULL text: no terms.
CREATE TABLE instance_banner (
    id          boolean     PRIMARY KEY DEFAULT true CHECK (id),
    text        text        NOT NULL CHECK (char_length(text) BETWEEN 1 AND 500),
    level       text        NOT NULL CHECK (level IN ('info', 'warning', 'critical')),
    dismissible boolean     NOT NULL DEFAULT true,
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE terms_of_service (
    id         uuid        PRIMARY KEY DEFAULT uuidv7(),
    text       text        NOT NULL CHECK (char_length(text) BETWEEN 1 AND 20000),
    created_by uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    -- Withdrawn terms no longer have to be accepted.
    withdrawn_at timestamptz
);
ALTER TABLE users ADD COLUMN terms_accepted_id uuid REFERENCES terms_of_service (id) ON DELETE SET NULL;

-- +goose Down
ALTER TABLE users DROP COLUMN terms_accepted_id;
DROP TABLE terms_of_service;
DROP TABLE instance_banner;
DROP TABLE playbook_runs;
DROP TABLE playbooks;
DROP TABLE message_reports;
DROP TABLE automod_rules;
ALTER TABLE workspaces DROP COLUMN welcome;
ALTER TABLE workspace_members DROP COLUMN onboarded_at, DROP COLUMN timeout_until;
DROP TABLE event_rsvps;
DROP TABLE events;
DROP TABLE poll_votes;
DROP TABLE poll_options;
DROP TABLE polls;
DROP INDEX messages_channel_author_idx;
ALTER TABLE messages DROP COLUMN tags, DROP COLUMN title;
ALTER TABLE channels DROP COLUMN slow_mode_seconds, DROP COLUMN forum_tags;
DELETE FROM channels WHERE kind = 'forum';
ALTER TABLE channels DROP CONSTRAINT channels_kind_check;
ALTER TABLE channels ADD CONSTRAINT channels_kind_check
    CHECK (kind IN ('standard', 'announcement', 'direct', 'group'));

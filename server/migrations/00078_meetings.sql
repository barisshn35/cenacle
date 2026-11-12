-- +goose Up
-- Meetings and calendar (ADR 0054): planned calls in a channel or conversation,
-- invitees and their answers, e-mails to send, reminders sent and private
-- calendar subscriptions. The app now tells the server its language (e-mails).
ALTER TABLE users ADD COLUMN language text CHECK (language IN ('en', 'tr'));

CREATE TABLE meetings (
    id           uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    channel_id   uuid NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    organizer_id uuid REFERENCES users (id) ON DELETE SET NULL,
    title        text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
    agenda       text NOT NULL DEFAULT '' CHECK (char_length(agenda) <= 4000),
    starts_at    timestamptz NOT NULL,
    ends_at      timestamptz NOT NULL,
    timezone     text NOT NULL CHECK (char_length(timezone) BETWEEN 1 AND 64),
    -- A subset of RFC 5545 RRULE ('' when it does not repeat).
    rrule        text NOT NULL DEFAULT '' CHECK (char_length(rrule) <= 200),
    -- Occurrences cancelled one by one (their start instants).
    exdates      timestamptz[] NOT NULL DEFAULT '{}',
    -- The last instant any occurrence can start (for range queries).
    last_start   timestamptz NOT NULL,
    sequence     integer NOT NULL DEFAULT 0,
    cancelled_at timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CHECK (ends_at > starts_at AND ends_at - starts_at <= interval '24 hours'),
    CHECK (last_start >= starts_at)
);
CREATE INDEX meetings_channel ON meetings (channel_id);
CREATE INDEX meetings_range ON meetings (starts_at, last_start) WHERE cancelled_at IS NULL;

CREATE TABLE meeting_invitees (
    meeting_id   uuid NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
    user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    response     text NOT NULL DEFAULT 'pending' CHECK (response IN ('pending', 'yes', 'maybe', 'no')),
    responded_at timestamptz,
    PRIMARY KEY (meeting_id, user_id)
);
CREATE INDEX meeting_invitees_user ON meeting_invitees (user_id);

-- E-mails to send about a meeting (written with the change, sent by a job).
CREATE TABLE meeting_mails (
    id         uuid PRIMARY KEY DEFAULT uuidv7(),
    meeting_id uuid NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind       text NOT NULL CHECK (kind IN ('invite', 'update', 'cancel')),
    -- What changed (an update): the earlier start and end.
    was_starts_at timestamptz,
    was_ends_at   timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    attempts   integer NOT NULL DEFAULT 0,
    sent_at    timestamptz
);
CREATE INDEX meeting_mails_due ON meeting_mails (created_at) WHERE sent_at IS NULL;

-- Reminders already given (one per person and occurrence).
CREATE TABLE meeting_reminders (
    meeting_id uuid NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    occurrence timestamptz NOT NULL,
    sent_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (meeting_id, user_id, occurrence)
);

-- Private calendar subscription addresses (the token is stored hashed).
CREATE TABLE calendar_feeds (
    user_id    uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    token_hash bytea NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE calendar_feeds;
DROP TABLE meeting_reminders;
DROP TABLE meeting_mails;
DROP TABLE meeting_invitees;
DROP TABLE meetings;
ALTER TABLE users DROP COLUMN language;

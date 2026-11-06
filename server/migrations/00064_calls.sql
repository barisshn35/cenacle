-- SPDX-License-Identifier: AGPL-3.0-only
-- +goose Up
ALTER TABLE workspaces
    ADD COLUMN calls_enabled boolean NOT NULL DEFAULT false,
    ADD COLUMN calls_guest_start boolean NOT NULL DEFAULT false,
    ADD COLUMN calls_max_participants integer NOT NULL DEFAULT 8
        CHECK (calls_max_participants BETWEEN 2 AND 16),
    ADD COLUMN calls_max_bitrate integer NOT NULL DEFAULT 2500000
        CHECK (calls_max_bitrate BETWEEN 64000 AND 10000000);

CREATE TABLE calls (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    nonce uuid NOT NULL,
    state text NOT NULL CHECK (state IN ('ringing', 'active', 'ended')),
    created_at timestamptz NOT NULL DEFAULT now(),
    ring_until timestamptz,
    started_at timestamptz,
    ended_at timestamptz,
    end_reason text NOT NULL DEFAULT '',
    node_id text NOT NULL,
    node_generation uuid NOT NULL,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    CHECK ((state = 'ended') = (ended_at IS NOT NULL)),
    CHECK (state <> 'ringing' OR ring_until IS NOT NULL),
    CHECK (ended_at IS NULL OR ended_at >= created_at),
    UNIQUE (channel_id, nonce)
);
CREATE UNIQUE INDEX calls_one_open_channel ON calls(channel_id) WHERE ended_at IS NULL;
CREATE INDEX calls_channel_history ON calls(channel_id, id DESC);
CREATE INDEX calls_orphan_scan ON calls(node_id, node_generation) WHERE ended_at IS NULL;

CREATE TABLE call_participants (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
    user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    session_id uuid,
    state text NOT NULL CHECK (state IN ('reserved', 'connected', 'reconnecting', 'left')),
    reserved_until timestamptz,
    joined_at timestamptz,
    left_at timestamptz,
    redacted_at timestamptz,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    transport_generation bigint NOT NULL DEFAULT 0,
    CHECK ((state = 'left') = (left_at IS NOT NULL)),
    CHECK (state <> 'reserved' OR reserved_until IS NOT NULL),
    CHECK (state = 'left' OR (user_id IS NOT NULL AND session_id IS NOT NULL))
);
-- Reservations are included: simultaneous token requests cannot overbook users.
CREATE UNIQUE INDEX call_participants_one_open_user ON call_participants(user_id)
    WHERE left_at IS NULL;
CREATE INDEX call_participants_call ON call_participants(call_id, id);
CREATE INDEX call_participants_user_history ON call_participants(user_id, call_id);
CREATE INDEX call_participants_session ON call_participants(session_id) WHERE left_at IS NULL;

-- A call overlaps a hold's half-open time range. A matching channel or any
-- participant/initiator keeps the complete metadata record, never media bytes.
-- +goose StatementBegin
CREATE FUNCTION call_held(call_uuid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS (
  SELECT 1 FROM calls c JOIN channels ch ON ch.id = c.channel_id
  JOIN legal_holds h ON h.workspace_id = ch.workspace_id AND h.released_at IS NULL
  WHERE c.id = call_uuid
   AND (c.channel_id = ANY(h.channel_ids) OR c.created_by = ANY(h.user_ids)
        OR EXISTS (SELECT 1 FROM call_participants p WHERE p.call_id = c.id AND p.user_id = ANY(h.user_ids)))
   AND (h.starts_at IS NULL OR coalesce(c.ended_at, now()) >= h.starts_at)
   AND (h.ends_at IS NULL OR c.created_at < h.ends_at)
 )
$$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION call_summary_held(cards jsonb) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN cards->0->'call_summary'->>'call_id' ~
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
 THEN call_held((cards->0->'call_summary'->>'call_id')::uuid) ELSE false END
$$;
-- +goose StatementEnd

-- +goose Down
DROP FUNCTION call_summary_held(jsonb);
DROP FUNCTION call_held(uuid);
DROP TABLE call_participants;
DROP TABLE calls;
ALTER TABLE workspaces DROP COLUMN calls_enabled, DROP COLUMN calls_guest_start,
    DROP COLUMN calls_max_participants, DROP COLUMN calls_max_bitrate;

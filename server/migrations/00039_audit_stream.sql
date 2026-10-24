-- +goose Up
-- Audit export and SIEM streaming (v0.36): the audit log of the whole
-- installation goes, as it is written, to an HTTP endpoint (signed NDJSON) or a
-- syslog receiver (RFC 5424 over TCP, optionally TLS). The cursor is the last
-- event sent; streaming starts with events written after it was turned on.
ALTER TABLE instance_settings
    ADD COLUMN audit_stream_kind    text        NOT NULL DEFAULT 'none' CHECK (audit_stream_kind IN ('none', 'http', 'syslog')),
    ADD COLUMN audit_stream_address text        NOT NULL DEFAULT '' CHECK (char_length(audit_stream_address) <= 500),
    ADD COLUMN audit_stream_secret  text        NOT NULL DEFAULT '',
    ADD COLUMN audit_stream_tls     boolean     NOT NULL DEFAULT true,
    ADD COLUMN audit_stream_cursor  uuid,
    ADD COLUMN audit_stream_error   text        NOT NULL DEFAULT '',
    ADD COLUMN audit_stream_sent_at timestamptz;
CREATE INDEX audit_events_action_idx ON audit_events (action, id DESC);

-- +goose Down
DROP INDEX audit_events_action_idx;
ALTER TABLE instance_settings
    DROP COLUMN audit_stream_sent_at, DROP COLUMN audit_stream_error, DROP COLUMN audit_stream_cursor,
    DROP COLUMN audit_stream_tls, DROP COLUMN audit_stream_secret, DROP COLUMN audit_stream_address,
    DROP COLUMN audit_stream_kind;

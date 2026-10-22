-- SPDX-License-Identifier: AGPL-3.0-only
--
-- Users signed in through an identity provider, and their sessions.

-- +goose Up
CREATE TABLE users (
    id             uuid        PRIMARY KEY DEFAULT uuidv7(),
    -- Identity provider ("cenacle-id") and the subject it issued: the stable
    -- key of the account. The e-mail address is not a key; it can change.
    auth_service   text        NOT NULL,
    auth_data      text        NOT NULL,
    email          text        NOT NULL DEFAULT '',
    email_verified boolean     NOT NULL DEFAULT false,
    display_name   text        NOT NULL DEFAULT '',
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    last_login_at  timestamptz,
    CONSTRAINT users_auth_key UNIQUE (auth_service, auth_data)
);

CREATE TABLE sessions (
    id           uuid        PRIMARY KEY DEFAULT uuidv7(),
    user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- SHA-256 of the opaque token; the token itself is never stored.
    token_hash   bytea       NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    -- Absolute end of the session; the idle timeout is applied on read.
    expires_at   timestamptz NOT NULL,
    user_agent   text        NOT NULL DEFAULT '',
    ip_address   text        NOT NULL DEFAULT ''
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);
CREATE INDEX sessions_last_seen_at_idx ON sessions (last_seen_at);

-- +goose Down
DROP TABLE sessions;
DROP TABLE users;

-- +goose Up
-- Guest links (v0.35): a channel's managers let someone from outside join that
-- one channel for a while, with a password, without an account at Cenacle ID.
-- Only the SHA-256 of the link's token and an Argon2id hash of its password
-- are kept.
CREATE TABLE guest_links (
    id            uuid        PRIMARY KEY DEFAULT uuidv7(),
    channel_id    uuid        NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    name          text        NOT NULL DEFAULT '' CHECK (char_length(name) <= 80),
    token_hash    bytea       NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    password_hash text        NOT NULL,
    created_by    uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL,
    max_uses      integer     CHECK (max_uses IS NULL OR max_uses BETWEEN 1 AND 1000),
    uses          integer     NOT NULL DEFAULT 0,
    revoked_at    timestamptz
);
CREATE INDEX guest_links_channel_idx ON guest_links (channel_id);

-- The people who came in with a link; they leave with it.
ALTER TABLE users ADD COLUMN guest_link_id uuid REFERENCES guest_links (id) ON DELETE SET NULL;
CREATE INDEX users_guest_link_idx ON users (guest_link_id) WHERE guest_link_id IS NOT NULL;

-- +goose Down
-- Their accounts stay, deactivated; their sessions end.
DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE guest_link_id IS NOT NULL);
UPDATE users SET deactivated_at = coalesce(deactivated_at, now()) WHERE guest_link_id IS NOT NULL;
ALTER TABLE users DROP COLUMN guest_link_id;
DROP TABLE guest_links;

-- +goose Up
-- End-to-end encryption with device keys (MLS, RFC 9420). Every device of a
-- person has its own signing key; the channel's MLS group holds the devices
-- of its members. The server is the delivery service: it orders the group's
-- commits by epoch, keeps the latest GroupInfo so devices can join on their
-- own, and stores message envelopes ("mls:v1:…") it cannot read.

CREATE TABLE e2e_devices (
    id            uuid        PRIMARY KEY DEFAULT uuidv7(),
    user_id       uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name          text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    -- Ed25519 public key of the device's MLS credential.
    signature_key bytea       NOT NULL CHECK (octet_length(signature_key) = 32),
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now(),
    revoked_at    timestamptz
);
CREATE INDEX e2e_devices_user_idx ON e2e_devices (user_id) WHERE revoked_at IS NULL;

-- MLS channels: encrypted, without a passphrase key check.
ALTER TABLE channels ADD COLUMN mls boolean NOT NULL DEFAULT false;
ALTER TABLE channels ADD CONSTRAINT channels_mls_encrypted CHECK (NOT mls OR (encrypted AND key_check = ''));

CREATE TABLE mls_groups (
    channel_id uuid        PRIMARY KEY REFERENCES channels (id) ON DELETE CASCADE,
    epoch      bigint      NOT NULL CHECK (epoch >= 0),
    -- The GroupInfo of the current epoch (with the external public key and the
    -- ratchet tree), from the device that made the epoch.
    group_info bytea       NOT NULL CHECK (octet_length(group_info) <= 524288),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Commits in order: the commit that leaves epoch N (to N + 1).
CREATE TABLE mls_commits (
    channel_id uuid        NOT NULL REFERENCES mls_groups (channel_id) ON DELETE CASCADE,
    epoch      bigint      NOT NULL,
    device_id  uuid        REFERENCES e2e_devices (id) ON DELETE SET NULL,
    data       bytea       NOT NULL CHECK (octet_length(data) <= 524288),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, epoch)
);

-- The devices in a group, as their commits declared them.
CREATE TABLE mls_members (
    channel_id   uuid   NOT NULL REFERENCES mls_groups (channel_id) ON DELETE CASCADE,
    device_id    uuid   NOT NULL REFERENCES e2e_devices (id) ON DELETE CASCADE,
    joined_epoch bigint NOT NULL,
    PRIMARY KEY (channel_id, device_id)
);
CREATE INDEX mls_members_device_idx ON mls_members (device_id);

-- A person's recovery key: a verifier (an HMAC with the key), and the key
-- sealed for the organization's escrow key when escrow is on.
CREATE TABLE e2e_recovery (
    user_id       uuid        PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    verifier      bytea       NOT NULL CHECK (octet_length(verifier) = 32),
    escrow        bytea       CHECK (octet_length(escrow) <= 1024),
    escrow_key_id text        CHECK (char_length(escrow_key_id) <= 64),
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- History backups: texts a person's devices read, sealed with their recovery
-- key, so a new device can show messages from before it joined.
CREATE TABLE e2e_backups (
    id         uuid        PRIMARY KEY DEFAULT uuidv7(),
    user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    channel_id uuid        NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    data       bytea       NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 1048576),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX e2e_backups_user_idx ON e2e_backups (user_id, channel_id, id);

-- The organization's escrow key (SPKI, P-256), when recovery keys must be
-- sealed for it too.
CREATE TABLE e2e_escrow (
    singleton  boolean     PRIMARY KEY DEFAULT true CHECK (singleton),
    key_id     text        NOT NULL CHECK (char_length(key_id) BETWEEN 1 AND 64),
    public_key bytea       NOT NULL CHECK (octet_length(public_key) <= 512),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Files of encrypted channels are encrypted in the browser: no previews.
ALTER TABLE files ADD COLUMN encrypted boolean NOT NULL DEFAULT false;

-- NOT VALID: the rule only allows more than before, so the rows there already
-- keep to it; checking them all here would lock messages for the whole scan
-- (00045 validates it without blocking writes).
ALTER TABLE messages DROP CONSTRAINT messages_body_check;
ALTER TABLE messages ADD CONSTRAINT messages_body_check
    CHECK ((char_length(body) <= 4000 OR (body LIKE 'e2e:v1:%' AND char_length(body) <= 12000)
            OR (body LIKE 'mls:v1:%' AND char_length(body) <= 32000))
           AND (body <> '' OR attachments <> '[]'::jsonb OR has_files OR sticker_id IS NOT NULL
                OR task_id IS NOT NULL OR submission_id IS NOT NULL)) NOT VALID;

-- +goose Down
DELETE FROM messages WHERE body LIKE 'mls:v1:%';
ALTER TABLE messages DROP CONSTRAINT messages_body_check;
ALTER TABLE messages ADD CONSTRAINT messages_body_check
    CHECK ((char_length(body) <= 4000 OR (body LIKE 'e2e:v1:%' AND char_length(body) <= 12000))
           AND (body <> '' OR attachments <> '[]'::jsonb OR has_files OR sticker_id IS NOT NULL
                OR task_id IS NOT NULL OR submission_id IS NOT NULL));
ALTER TABLE files DROP COLUMN encrypted;
DROP TABLE e2e_escrow;
DROP TABLE e2e_backups;
DROP TABLE e2e_recovery;
DROP TABLE mls_members;
DROP TABLE mls_commits;
DROP TABLE mls_groups;
-- The release before cannot open device-key channels (their messages are gone
-- above): they stay, archived, rather than look like passphrase channels.
UPDATE channels SET archived_at = coalesce(archived_at, now()) WHERE mls;
ALTER TABLE channels DROP CONSTRAINT channels_mls_encrypted;
ALTER TABLE channels DROP COLUMN mls;
DROP TABLE e2e_devices;

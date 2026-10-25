-- End-to-end encryption with device keys (MLS): devices, groups, commits,
-- recovery keys and history backups.

-- name: CountActiveDevices :one
SELECT count(*) FROM e2e_devices WHERE user_id = @user_id AND revoked_at IS NULL;

-- name: CreateDevice :one
INSERT INTO e2e_devices (user_id, name, signature_key) VALUES (@user_id, @name, @signature_key)
RETURNING *;

-- name: ListActiveDevices :many
SELECT * FROM e2e_devices WHERE user_id = @user_id AND revoked_at IS NULL ORDER BY created_at;

-- name: GetActiveDevice :one
SELECT * FROM e2e_devices WHERE id = @id AND user_id = @user_id AND revoked_at IS NULL;

-- name: TouchDevice :exec
UPDATE e2e_devices SET last_seen_at = now() WHERE id = @id AND last_seen_at < now() - interval '1 minute';

-- name: RevokeDevice :one
UPDATE e2e_devices SET revoked_at = now() WHERE id = @id AND user_id = @user_id AND revoked_at IS NULL
RETURNING *;

-- name: ChannelsOfDevice :many
-- ChannelsOfDevice lists the groups a device is in.
SELECT channel_id FROM mls_members WHERE device_id = @device_id;

-- name: EnableMLS :execrows
-- EnableMLS turns on end-to-end encryption with device keys; it cannot be
-- turned off.
UPDATE channels SET encrypted = true, mls = true WHERE id = @id AND NOT encrypted;

-- name: CreateMLSGroup :exec
INSERT INTO mls_groups (channel_id, epoch, group_info) VALUES (@channel_id, 0, @group_info);

-- name: GetMLSGroup :one
SELECT * FROM mls_groups WHERE channel_id = @channel_id;

-- name: AdvanceMLSGroup :one
-- AdvanceMLSGroup moves a group to the next epoch when it is still at the
-- epoch the commit was made in (else another commit came first).
UPDATE mls_groups SET epoch = epoch + 1, group_info = @group_info, updated_at = now()
WHERE channel_id = @channel_id AND epoch = @epoch
RETURNING epoch;

-- name: InsertMLSCommit :exec
INSERT INTO mls_commits (channel_id, epoch, device_id, data) VALUES (@channel_id, @epoch, @device_id, @data);

-- name: ListMLSCommits :many
SELECT * FROM mls_commits WHERE channel_id = @channel_id AND epoch >= @from_epoch ORDER BY epoch LIMIT 100;

-- name: AddMLSMember :exec
INSERT INTO mls_members (channel_id, device_id, joined_epoch) VALUES (@channel_id, @device_id, @joined_epoch)
ON CONFLICT (channel_id, device_id) DO UPDATE SET joined_epoch = EXCLUDED.joined_epoch;

-- name: RemoveMLSMembers :exec
DELETE FROM mls_members WHERE channel_id = @channel_id AND device_id = ANY(@device_ids::uuid[]);

-- name: ListMLSMembers :many
-- ListMLSMembers lists a group's devices; stale ones (revoked, or of people
-- no longer in the channel) are to be removed by the next commit.
SELECT m.device_id, d.user_id, d.name, d.signature_key, m.joined_epoch,
    (d.revoked_at IS NOT NULL OR cm.user_id IS NULL)::boolean AS stale
FROM mls_members m
JOIN e2e_devices d ON d.id = m.device_id
LEFT JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id = d.user_id
WHERE m.channel_id = @channel_id
ORDER BY m.joined_epoch, m.device_id;

-- name: ListUserDevicesFor :many
-- ListUserDevicesFor lists people's devices with their public keys, removed
-- ones too (their earlier commits and messages are still checked with them).
SELECT id, user_id, name, signature_key, created_at, revoked_at FROM e2e_devices
WHERE user_id = ANY(@user_ids::uuid[])
ORDER BY user_id, created_at;

-- name: GetRecovery :one
SELECT * FROM e2e_recovery WHERE user_id = @user_id;

-- name: SetRecovery :one
INSERT INTO e2e_recovery (user_id, verifier, escrow, escrow_key_id)
VALUES (@user_id, @verifier, sqlc.narg(escrow), sqlc.narg(escrow_key_id))
ON CONFLICT (user_id) DO UPDATE SET verifier = EXCLUDED.verifier, escrow = EXCLUDED.escrow,
    escrow_key_id = EXCLUDED.escrow_key_id, created_at = now()
RETURNING *;

-- name: DeleteRecovery :exec
-- DeleteRecovery forgets the recovery key and the backups sealed with it.
WITH gone AS (DELETE FROM e2e_backups b WHERE b.user_id = @user_id)
DELETE FROM e2e_recovery r WHERE r.user_id = @user_id;

-- name: InsertBackup :one
INSERT INTO e2e_backups (user_id, channel_id, data) VALUES (@user_id, @channel_id, @data) RETURNING id;

-- name: CountBackupBytes :one
SELECT coalesce(sum(octet_length(data)), 0)::bigint FROM e2e_backups WHERE user_id = @user_id;

-- name: ListBackups :many
SELECT id, data, created_at FROM e2e_backups
WHERE user_id = @user_id AND channel_id = @channel_id AND id > @after
ORDER BY id LIMIT 50;

-- name: ListBackupsForEscrow :many
-- ListBackupsForEscrow reads the backups of a person (all channels) for the
-- escrow command.
SELECT b.id, b.channel_id, b.data, b.created_at FROM e2e_backups b
WHERE b.user_id = @user_id AND (sqlc.narg(channel_id)::uuid IS NULL OR b.channel_id = sqlc.narg(channel_id))
ORDER BY b.channel_id, b.id;

-- name: GetEscrowKey :one
SELECT * FROM e2e_escrow WHERE singleton;

-- name: SetEscrowKey :one
INSERT INTO e2e_escrow (key_id, public_key) VALUES (@key_id, @public_key)
ON CONFLICT (singleton) DO UPDATE SET key_id = EXCLUDED.key_id, public_key = EXCLUDED.public_key, updated_at = now()
RETURNING *;

-- name: DeleteEscrowKey :exec
DELETE FROM e2e_escrow WHERE singleton;

-- name: FindUserForEscrow :one
SELECT id, email, display_name FROM users WHERE lower(email) = lower(@email) AND email <> '' ORDER BY created_at LIMIT 1;

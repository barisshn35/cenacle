-- name: CreateFederationInvite :one
INSERT INTO federation_invites (workspace_id, name, token_hash, secret, created_by, expires_at)
VALUES (@workspace_id, @name, @token_hash, @secret, @created_by, @expires_at)
RETURNING *;

-- name: UseFederationInvite :one
-- UseFederationInvite takes an unused, unexpired invitation (once).
UPDATE federation_invites SET used_at = now()
WHERE token_hash = @token_hash AND used_at IS NULL AND expires_at > now()
RETURNING *;

-- name: CreateFederationConnection :one
INSERT INTO federation_connections (workspace_id, name, url, secret, remote_id, status, created_by)
VALUES (@workspace_id, @name, @url, @secret, sqlc.narg(remote_id), @status, sqlc.narg(created_by))
RETURNING *;

-- name: ActivateFederationConnection :one
UPDATE federation_connections SET remote_id = @remote_id, status = 'active', last_error = ''
WHERE id = @id
RETURNING *;

-- name: GetFederationConnection :one
SELECT * FROM federation_connections WHERE id = @id;

-- name: ListFederationConnections :many
SELECT * FROM federation_connections WHERE workspace_id = @workspace_id ORDER BY lower(name);

-- name: SetFederationConnectionStatus :one
UPDATE federation_connections SET status = @status WHERE id = @id RETURNING *;

-- name: DeleteFederationConnection :exec
DELETE FROM federation_connections WHERE id = @id;

-- name: TouchFederationConnection :exec
UPDATE federation_connections SET last_seen_at = now() WHERE id = @id;

-- name: RequireFederationV2 :exec
-- RequireFederationV2 records that the connection's server signs with v2, so
-- requests without it are refused from now on (and that it no longer looks
-- moved back).
UPDATE federation_connections SET signature_version = 2, v1_refused_at = NULL
WHERE id = @id AND (signature_version < 2 OR v1_refused_at IS NOT NULL);

-- name: NoteFederationV1Refused :exec
-- NoteFederationV1Refused records that a valid request signed only with v1
-- was refused on a connection that requires v2 (at most once a minute).
UPDATE federation_connections SET v1_refused_at = now()
WHERE id = @id AND signature_version >= 2
  AND (v1_refused_at IS NULL OR v1_refused_at < now() - interval '1 minute');

-- name: AcceptFederationV1 :one
-- AcceptFederationV1 takes requests signed only with v1 from the connection's
-- server again, until it next signs with v2.
UPDATE federation_connections SET signature_version = 1, v1_refused_at = NULL WHERE id = @id RETURNING *;

-- name: SetFederationError :exec
UPDATE federation_connections SET last_error = @last_error WHERE id = @id;

-- name: ShareChannel :one
INSERT INTO shared_channels (channel_id, connection_id) VALUES (@channel_id, @connection_id)
ON CONFLICT (channel_id, connection_id) DO UPDATE SET channel_id = excluded.channel_id
RETURNING *;

-- name: AcceptSharedChannel :one
-- AcceptSharedChannel records the id the other side gave a channel we offered.
-- A channel encrypted end to end since it was offered is not shared after all.
UPDATE shared_channels SET remote_channel_id = @remote_channel_id, status = 'active'
WHERE channel_id = @channel_id AND connection_id = @connection_id
  AND NOT EXISTS (SELECT 1 FROM channels c WHERE c.id = @channel_id AND c.encrypted)
RETURNING *;

-- name: CreateActiveSharedChannel :one
INSERT INTO shared_channels (channel_id, connection_id, remote_channel_id, status)
VALUES (@channel_id, @connection_id, @remote_channel_id, 'active')
RETURNING *;

-- name: GetSharedChannel :one
SELECT * FROM shared_channels WHERE channel_id = @channel_id AND connection_id = @connection_id;

-- name: ListSharedChannels :many
-- ListSharedChannels returns the channels shared over a connection, with their names.
SELECT s.*, c.name AS channel_name FROM shared_channels s JOIN channels c ON c.id = s.channel_id
WHERE s.connection_id = @connection_id ORDER BY lower(c.name);

-- name: ListChannelShares :many
-- ListChannelShares returns the active connections a channel is shared over.
SELECT s.*, f.name AS connection_name, f.status AS connection_status
FROM shared_channels s JOIN federation_connections f ON f.id = s.connection_id
WHERE s.channel_id = @channel_id;

-- name: UnshareChannel :exec
DELETE FROM shared_channels WHERE channel_id = @channel_id AND connection_id = @connection_id;

-- name: UpsertChannelOffer :one
INSERT INTO channel_offers (connection_id, remote_channel_id, name, topic)
VALUES (@connection_id, @remote_channel_id, @name, @topic)
ON CONFLICT (connection_id, remote_channel_id) DO UPDATE SET name = excluded.name, topic = excluded.topic
RETURNING *;

-- name: ListChannelOffers :many
SELECT o.*, f.name AS connection_name FROM channel_offers o
JOIN federation_connections f ON f.id = o.connection_id
WHERE f.workspace_id = @workspace_id ORDER BY o.id;

-- name: GetChannelOffer :one
SELECT * FROM channel_offers WHERE id = @id;

-- name: DeleteChannelOffer :exec
DELETE FROM channel_offers WHERE id = @id;

-- name: QueueFederationDelivery :exec
-- QueueFederationDelivery queues an event; one that carries a message's content
-- names it (message_id), so the copy goes when the message does.
INSERT INTO federation_deliveries (connection_id, event, message_id)
VALUES (@connection_id, @event, (SELECT x.id FROM messages x WHERE x.id = sqlc.narg(message_id)::uuid));

-- name: DueFederationConnections :many
-- DueFederationConnections returns the active connections whose oldest queued
-- event is due. A connection's events go in the order they were queued, so an
-- event waiting for its retry holds back the ones queued after it.
SELECT f.id FROM federation_connections f
WHERE f.status = 'active'
  AND (SELECT d.next_attempt_at FROM federation_deliveries d
       WHERE d.connection_id = f.id ORDER BY d.id LIMIT 1) <= now()
LIMIT 50;

-- name: LockFederationSending :one
-- LockFederationSending makes the caller's transaction the only sender of a
-- connection (false: another one is sending). The schema is part of the key,
-- so installations sharing a database do not wait for each other.
SELECT pg_try_advisory_xact_lock(
    hashtextextended(current_schema() || '.federation-send:' || sqlc.arg(connection_id)::uuid::text, 0))::boolean AS locked;

-- name: ClaimFederationDeliveries :many
-- ClaimFederationDeliveries takes the oldest events of a connection, in order,
-- for the caller's transaction; nothing while the oldest one is not due. The
-- caller holds LockFederationSending.
SELECT d.* FROM federation_deliveries d
WHERE d.connection_id = @connection_id
  AND (SELECT o.next_attempt_at FROM federation_deliveries o
       WHERE o.connection_id = @connection_id ORDER BY o.id LIMIT 1) <= now()
ORDER BY d.id
LIMIT @row_limit
FOR UPDATE;

-- name: DeleteFederationDeliveries :exec
DELETE FROM federation_deliveries WHERE id = ANY (@ids::uuid[]);

-- name: RetryFederationDeliveries :exec
UPDATE federation_deliveries SET attempts = attempts + 1,
    next_attempt_at = now() + make_interval(secs => least(3600, 5 * power(2, least(attempts, 12))))
WHERE id = ANY (@ids::uuid[]);

-- name: ActiveSharesOfChannel :many
-- ActiveSharesOfChannel returns where a channel's events go: active shares of
-- connections that are active or paused (a paused connection's events wait, in
-- order, until it resumes, so an edit or deletion made meanwhile is not lost).
SELECT s.connection_id, s.remote_channel_id FROM shared_channels s
JOIN federation_connections f ON f.id = s.connection_id AND f.status IN ('active', 'disabled')
WHERE s.channel_id = @channel_id AND s.status = 'active';

-- name: GetRemoteAuthor :one
-- GetRemoteAuthor returns the connection a user came over, if any.
SELECT auth_data FROM users WHERE id = @id AND auth_service = 'remote';

-- name: UpsertRemoteUser :one
INSERT INTO users (auth_service, auth_data, display_name)
VALUES ('remote', @auth_data, @display_name)
ON CONFLICT (auth_service, auth_data) DO UPDATE SET display_name = excluded.display_name, updated_at = now()
RETURNING *;

-- name: RecordFederatedMessage :exec
INSERT INTO federated_messages (message_id, connection_id, remote_message_id)
VALUES (@message_id, @connection_id, @remote_message_id)
ON CONFLICT DO NOTHING;

-- name: LocalMessageOf :one
SELECT message_id FROM federated_messages WHERE connection_id = @connection_id AND remote_message_id = @remote_message_id;

-- name: RemoteMessageOf :one
SELECT remote_message_id FROM federated_messages WHERE connection_id = @connection_id AND message_id = @message_id;

-- name: GetFederationInviteByHash :one
SELECT * FROM federation_invites WHERE token_hash = @token_hash AND used_at IS NULL AND expires_at > now();

-- name: SetFederationConnectionPolicy :one
UPDATE federation_connections SET receive_messages = @receive_messages, receive_reactions = @receive_reactions,
    receive_edits = @receive_edits, requests_per_minute = @requests_per_minute
WHERE id = @id
RETURNING *;

-- SPDX-License-Identifier: AGPL-3.0-only

-- name: GetCall :one
SELECT * FROM calls WHERE id = @id;

-- name: LockCall :one
SELECT * FROM calls WHERE id = @id FOR UPDATE;

-- name: GetChannelCall :one
SELECT * FROM calls WHERE channel_id = @channel_id AND ended_at IS NULL;

-- name: CreateCall :one
INSERT INTO calls (channel_id, created_by, nonce, state, ring_until, node_id, node_generation)
VALUES (@channel_id, @created_by, @nonce, @state, sqlc.narg(ring_until), @node_id, @node_generation)
RETURNING *;

-- name: GetCallByNonce :one
SELECT * FROM calls WHERE channel_id = @channel_id AND nonce = @nonce;

-- name: ListCallParticipants :many
-- Live snapshots/reconciliation are bounded; historical export has its own cursor.
SELECT * FROM call_participants WHERE call_id = @call_id AND redacted_at IS NULL
 AND (left_at IS NULL OR left_at > now() - interval '30 seconds')
ORDER BY id DESC LIMIT 64;

-- name: GetOpenUserCallParticipant :one
SELECT * FROM call_participants WHERE user_id = @user_id AND left_at IS NULL FOR UPDATE;

-- name: ReserveCallParticipant :one
INSERT INTO call_participants (call_id, user_id, session_id, state, reserved_until)
VALUES (@call_id, @user_id, @session_id, 'reserved', now() + interval '60 seconds')
RETURNING *;

-- name: CountOpenCallParticipants :one
SELECT count(*) FROM call_participants WHERE call_id = @call_id AND left_at IS NULL;

-- name: ExpireCallReservations :execrows
UPDATE call_participants SET state = 'left', left_at = now(), session_id = NULL
WHERE call_id = @call_id AND state = 'reserved' AND reserved_until <= now();

-- name: ConnectCallParticipant :one
UPDATE call_participants SET state = 'connected', joined_at = coalesce(joined_at, now()),
    reserved_until = NULL, last_seen_at = now(), transport_generation = @transport_generation
WHERE id = @id AND call_id = @call_id AND left_at IS NULL
  AND transport_generation <= @transport_generation
RETURNING *;

-- name: LeaveCallParticipant :execrows
UPDATE call_participants SET state = 'left', left_at = now(), session_id = NULL
WHERE id = @id AND call_id = @call_id AND left_at IS NULL
  AND transport_generation = @transport_generation;

-- name: ActivateCall :one
UPDATE calls SET state = 'active', revision = revision + 1
WHERE id = @id AND ended_at IS NULL RETURNING *;

-- name: EndCall :one
UPDATE calls SET state = 'ended', ended_at = now(), end_reason = @end_reason, revision = revision + 1
WHERE id = @id AND ended_at IS NULL RETURNING *;

-- name: CloseCallParticipants :exec
UPDATE call_participants SET state = 'left', left_at = now(), session_id = NULL
WHERE call_id = @call_id AND left_at IS NULL;

-- name: GetCallSettings :one
SELECT calls_enabled, calls_guest_start, calls_max_participants, calls_max_bitrate, calls_captions
FROM workspaces WHERE id = @workspace_id;

-- name: UpdateCallSettings :exec
UPDATE workspaces SET calls_enabled = @calls_enabled, calls_guest_start = @calls_guest_start,
    calls_max_participants = @calls_max_participants, calls_max_bitrate = @calls_max_bitrate,
    calls_captions = @calls_captions
WHERE id = @workspace_id;

-- name: ExpireUserCallReservation :exec
UPDATE call_participants SET state = 'left', left_at = now(), session_id = NULL
WHERE user_id = @user_id AND state = 'reserved' AND reserved_until <= now();

-- name: ReconnectCallParticipant :execrows
UPDATE call_participants SET state = 'reconnecting', reserved_until = now() + interval '30 seconds'
WHERE id = @id AND call_id = @call_id AND left_at IS NULL
  AND transport_generation = @transport_generation;

-- name: ExpireDisconnectedCallParticipants :execrows
UPDATE call_participants SET state = 'left', left_at = now(), session_id = NULL
WHERE call_id = @call_id AND state IN ('reserved', 'reconnecting') AND reserved_until <= now();

-- name: ListOpenCalls :many
SELECT * FROM calls WHERE ended_at IS NULL ORDER BY id;

-- name: CountJoinedCallParticipants :one
SELECT count(DISTINCT user_id) FROM call_participants WHERE call_id = @call_id AND joined_at IS NOT NULL;

-- name: CreateCallSummaryMessage :one
-- Empty body keeps this local under the federation text-only rule.
INSERT INTO messages (channel_id, author_id, body, nonce, attachments)
VALUES (@channel_id, @author_id, '', @nonce, @attachments)
ON CONFLICT ON CONSTRAINT messages_author_nonce_key DO NOTHING
RETURNING *;

-- name: CallAdmissionAllowed :one
SELECT EXISTS (
    SELECT 1 FROM calls c
    JOIN channels ch ON ch.id = c.channel_id
    JOIN workspaces w ON w.id = ch.workspace_id
    JOIN call_participants p ON p.call_id = c.id
    JOIN channel_members cm ON cm.channel_id = ch.id AND cm.user_id = p.user_id
    JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = p.user_id
    JOIN sessions s ON s.id = p.session_id AND s.user_id = p.user_id
    JOIN users u ON u.id = p.user_id
    WHERE c.id = @call_id AND p.id = @participant_id AND p.user_id = @user_id
      AND p.session_id = @session_id AND c.node_generation = @node_generation
      AND c.ended_at IS NULL AND p.left_at IS NULL AND p.redacted_at IS NULL AND w.calls_enabled
      AND ch.archived_at IS NULL AND NOT ch.encrypted AND NOT ch.mls
      AND (p.state = 'connected' OR p.reserved_until > now())
      AND (c.state = 'active' OR (c.created_by = p.user_id AND c.ring_until > now()))
      AND s.expires_at > now()
      AND u.deactivated_at IS NULL AND u.auth_service <> 'erased' AND NOT u.is_bot
);

-- name: ForceLeaveCallUser :execrows
UPDATE call_participants SET state = 'left', left_at = now(), session_id = NULL
WHERE call_id = @call_id AND user_id = @user_id AND left_at IS NULL;

-- name: BumpCallRevision :one
UPDATE calls SET revision = revision + 1 WHERE id = @id RETURNING *;

-- name: StartConnectedCall :one
UPDATE calls SET started_at = coalesce(started_at, now()), revision = revision + 1
WHERE id = @id AND state = 'active' RETURNING *;

-- name: LockCallCreation :exec
SELECT pg_advisory_xact_lock(hashtext(current_schema() || '.calls'));

-- name: CountOpenCalls :one
SELECT count(*) FROM calls WHERE ended_at IS NULL;

-- name: CountConnectedCallParticipants :one
SELECT count(*) FROM call_participants WHERE call_id = @call_id AND state = 'connected';

-- name: ListUserOpenCalls :many
SELECT DISTINCT c.* FROM calls c JOIN call_participants p ON p.call_id = c.id
WHERE p.user_id = @user_id AND p.left_at IS NULL AND c.ended_at IS NULL ORDER BY c.id;

-- name: EraseCallParticipants :execrows
DELETE FROM call_participants WHERE user_id = @user_id AND NOT call_held(call_id);

-- name: RedactHeldCallParticipants :execrows
UPDATE call_participants SET redacted_at = coalesce(redacted_at, now()), state = 'left',
 left_at = coalesce(left_at, now()), session_id = NULL, reserved_until = NULL
WHERE user_id = @user_id AND call_held(call_id);

-- name: EraseCallInitiator :execrows
UPDATE calls SET created_by = NULL WHERE created_by = @user_id AND NOT call_held(id);

-- name: PurgeReleasedCallRedactions :execrows
DELETE FROM call_participants WHERE id IN (
 SELECT p.id FROM call_participants p
 WHERE p.redacted_at IS NOT NULL AND NOT call_held(p.call_id)
 ORDER BY p.id LIMIT @row_limit
);

-- name: PurgeErasedCallInitiators :execrows
UPDATE calls SET created_by = NULL WHERE id IN (
 SELECT c.id FROM calls c JOIN users u ON u.id = c.created_by
 WHERE u.auth_service = 'erased' AND NOT call_held(c.id) ORDER BY c.id LIMIT @row_limit
);

-- name: PurgeExpiredCalls :execrows
DELETE FROM calls WHERE id IN (
 SELECT c.id FROM calls c JOIN channels ch ON ch.id = c.channel_id
 JOIN workspaces w ON w.id = ch.workspace_id
 WHERE c.ended_at IS NOT NULL AND coalesce(ch.retention_days, w.retention_days) IS NOT NULL
  AND c.ended_at < now() - make_interval(days => coalesce(ch.retention_days, w.retention_days))
  AND NOT call_held(c.id)
 ORDER BY c.id LIMIT @row_limit
);

-- name: UserCallMetadataAfter :many
SELECT c.id AS call_id, c.channel_id, c.state, c.created_at, c.started_at, c.ended_at, c.end_reason,
 p.id AS participant_id, p.state AS participant_state, p.joined_at, p.left_at
FROM calls c JOIN call_participants p ON p.call_id = c.id
WHERE p.user_id = @user_id AND p.redacted_at IS NULL
 AND (sqlc.narg(after)::uuid IS NULL OR p.id > sqlc.narg(after)::uuid)
ORDER BY p.id LIMIT @row_limit;

-- name: SetCallHand :execrows
-- SetCallHand raises (keeping the first time) or lowers the hand of a user's
-- open session in a call.
UPDATE call_participants
SET hand_raised_at = CASE WHEN @raised::boolean THEN coalesce(hand_raised_at, now()) ELSE NULL END
WHERE call_id = @call_id AND user_id = @user_id AND left_at IS NULL;

-- name: InCall :one
SELECT EXISTS (SELECT 1 FROM call_participants
               WHERE call_id = @call_id AND user_id = @user_id AND state = 'connected');

-- name: ListActiveCallsForUser :many
-- ListActiveCallsForUser lists the calls that have not ended in the channels
-- of a workspace the user is a member of.
SELECT k.* FROM calls k
JOIN channels c ON c.id = k.channel_id AND c.workspace_id = @workspace_id AND c.archived_at IS NULL
JOIN channel_members m ON m.channel_id = k.channel_id AND m.user_id = @user_id
WHERE k.ended_at IS NULL
ORDER BY k.created_at DESC
LIMIT 100;

-- name: SetCallCaptions :one
UPDATE calls SET captions_on = @captions_on, captions_by = CASE WHEN @captions_on THEN @user_id::uuid END,
    revision = revision + 1
WHERE id = @id AND ended_at IS NULL RETURNING *;

-- name: CallCaptionsAllowed :one
SELECT w.calls_captions FROM calls k
JOIN channels c ON c.id = k.channel_id JOIN workspaces w ON w.id = c.workspace_id
WHERE k.id = @call_id;

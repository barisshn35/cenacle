-- name: CreateSession :one
INSERT INTO sessions (user_id, token_hash, expires_at, user_agent, ip_address, idp_sid)
VALUES (@user_id, @token_hash, @expires_at, @user_agent, @ip_address, @idp_sid)
RETURNING *;

-- name: GetActiveSession :one
-- GetActiveSession returns the session of a token hash with its user, unless
-- it passed its absolute expiry or was idle for longer than idle_timeout.
SELECT sqlc.embed(s), sqlc.embed(u)
FROM sessions s
JOIN users u ON u.id = s.user_id
WHERE s.token_hash = @token_hash
  AND s.expires_at > now()
  AND s.last_seen_at > now() - sqlc.arg(idle_timeout)::interval;

-- name: TouchSession :exec
-- TouchSession records use of a session at most once per minute, which keeps
-- writes low while the idle timeout stays accurate to the minute.
UPDATE sessions
SET last_seen_at = now(), user_agent = @user_agent, ip_address = @ip_address
WHERE id = @id AND last_seen_at < now() - interval '1 minute';

-- name: DeleteSession :exec
DELETE FROM sessions WHERE id = @id;

-- name: DeleteExpiredSessions :execrows
DELETE FROM sessions
WHERE expires_at <= now()
   OR last_seen_at <= now() - sqlc.arg(idle_timeout)::interval;

-- name: SessionIsActive :one
-- SessionIsActive checks a session without recording use (long-lived
-- WebSocket connections re-check their session with it).
SELECT EXISTS (
    SELECT 1 FROM sessions
    WHERE id = @id
      AND expires_at > now()
      AND last_seen_at > now() - sqlc.arg(idle_timeout)::interval
);

-- name: ListUserSessions :many
-- ListUserSessions returns a user's usable sessions, most recently used first.
SELECT * FROM sessions
WHERE user_id = @user_id AND expires_at > now()
  AND last_seen_at > now() - sqlc.arg(idle_timeout)::interval
ORDER BY last_seen_at DESC, id DESC;

-- name: DeleteUserSession :execrows
DELETE FROM sessions WHERE id = @id AND user_id = @user_id;

-- name: DeleteOtherSessions :execrows
-- DeleteOtherSessions ends a user's sessions except one (uuid nil: all of them).
DELETE FROM sessions WHERE user_id = @user_id AND id <> @keep;

-- name: DeleteSessionsByIdpSid :many
-- DeleteSessionsByIdpSid ends the sessions of one Cenacle ID sign-in.
DELETE FROM sessions s
USING users u
WHERE s.user_id = u.id AND s.idp_sid = @idp_sid AND u.auth_service = @auth_service
  AND u.auth_data = @auth_data
RETURNING s.user_id;

-- name: DeleteSessionsBySubject :many
-- DeleteSessionsBySubject ends every session of an identity (logout without sid).
DELETE FROM sessions s
USING users u
WHERE s.user_id = u.id AND u.auth_service = @auth_service AND u.auth_data = @auth_data
RETURNING s.user_id;

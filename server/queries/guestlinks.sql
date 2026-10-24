-- name: CreateGuestLink :one
INSERT INTO guest_links (channel_id, name, token_hash, password_hash, created_by, expires_at, max_uses)
VALUES (@channel_id, @name, @token_hash, @password_hash, @created_by, @expires_at, sqlc.narg(max_uses))
RETURNING *;

-- name: ListGuestLinks :many
-- ListGuestLinks returns a channel's links that still work, newest first, with
-- how many people are in the channel through each.
SELECT l.*, (SELECT count(*) FROM users u WHERE u.guest_link_id = l.id AND u.deactivated_at IS NULL)::int AS guests
FROM guest_links l
WHERE l.channel_id = @channel_id AND l.revoked_at IS NULL AND l.expires_at > now()
ORDER BY l.id DESC;

-- name: GetGuestLinkByHash :one
SELECT l.*, c.name AS channel_name, w.name AS workspace_name, c.workspace_id
FROM guest_links l JOIN channels c ON c.id = l.channel_id JOIN workspaces w ON w.id = c.workspace_id
WHERE l.token_hash = @token_hash;

-- name: UseGuestLink :one
-- UseGuestLink counts a use of a link that still works.
UPDATE guest_links SET uses = uses + 1
WHERE id = @id AND revoked_at IS NULL AND expires_at > now() AND (max_uses IS NULL OR uses < max_uses)
RETURNING *;

-- name: RevokeGuestLink :execrows
UPDATE guest_links SET revoked_at = now() WHERE id = @id AND channel_id = @channel_id AND revoked_at IS NULL;

-- name: CreateLinkGuest :one
INSERT INTO users (auth_service, auth_data, display_name, directory_role, guest_link_id)
VALUES ('guest-link', @auth_data, @display_name, 'guest', @guest_link_id)
RETURNING *;

-- name: EndLinkGuests :execrows
-- EndLinkGuests deactivates the people of revoked and expired links.
UPDATE users SET deactivated_at = now(), updated_at = now()
WHERE guest_link_id IN (SELECT id FROM guest_links WHERE revoked_at IS NOT NULL OR expires_at <= now())
  AND deactivated_at IS NULL;

-- name: DeleteLinkGuestSessions :exec
DELETE FROM sessions WHERE user_id IN (
    SELECT u.id FROM users u JOIN guest_links l ON l.id = u.guest_link_id
    WHERE l.revoked_at IS NOT NULL OR l.expires_at <= now());

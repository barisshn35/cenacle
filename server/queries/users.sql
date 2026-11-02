-- name: UpsertUserFromIdentity :one
-- UpsertUserFromIdentity creates the user of an identity on first sign-in and
-- refreshes the profile claims on every later one.
INSERT INTO users (auth_service, auth_data, email, email_verified, display_name, last_login_at)
VALUES (@auth_service, @auth_data, @email, @email_verified, @display_name, now())
ON CONFLICT ON CONSTRAINT users_auth_key DO UPDATE
SET email          = EXCLUDED.email,
    email_verified = EXCLUDED.email_verified,
    display_name   = EXCLUDED.display_name,
    last_login_at  = now(),
    updated_at     = CASE
        WHEN (users.email, users.email_verified, users.display_name)
             IS DISTINCT FROM (EXCLUDED.email, EXCLUDED.email_verified, EXCLUDED.display_name)
        THEN now() ELSE users.updated_at END
RETURNING *;

-- name: GetUser :one
SELECT * FROM users WHERE id = @id;

-- name: ClearAdminExcept :exec
-- ClearAdminExcept removes the administrator flag from everyone but one user,
-- so that it can move to that user (there is at most one administrator).
UPDATE users SET is_admin = false WHERE is_admin AND id <> @id;

-- name: SetAdmin :exec
UPDATE users SET is_admin = @is_admin WHERE id = @id;

-- name: RevokeAdminUnlessEmail :exec
-- RevokeAdminUnlessEmail removes the administrator flag from a user whose
-- e-mail address is no longer the configured one ('' revokes it from all),
-- unless the directory makes them an administrator.
UPDATE users SET is_admin = false
WHERE is_admin AND (@email::text = '' OR lower(email) <> lower(@email::text))
  AND directory_role IS DISTINCT FROM 'admin';

-- name: SearchUsers :many
-- SearchUsers finds members of a workspace by name or e-mail address
-- (pattern: a LIKE pattern with % and _ escaped by the caller). With
-- restrict, only the given people match (a guest's visible people), before
-- the limit, so hidden members never take a place in the result.
SELECT u.id, u.display_name, u.email, u.is_bot
FROM users u
JOIN workspace_members wm ON wm.user_id = u.id AND wm.workspace_id = @workspace_id
WHERE (u.display_name ILIKE @pattern OR u.email ILIKE @pattern)
  AND (NOT @restrict::boolean OR u.id = ANY(@visible_ids::uuid[]))
ORDER BY lower(u.display_name), u.id
LIMIT @row_limit;

-- name: UserExists :one
SELECT EXISTS (SELECT 1 FROM users WHERE auth_service = @auth_service AND auth_data = @auth_data);

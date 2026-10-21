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

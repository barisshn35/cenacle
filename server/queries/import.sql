-- name: FindUserByEmail :one
-- FindUserByEmail finds the account of an address (a person who signed in
-- already wins over an earlier import).
SELECT * FROM users WHERE email <> '' AND lower(email) = lower(@email)
ORDER BY (auth_service = 'import') LIMIT 1;

-- name: CreateImportedUser :one
-- CreateImportedUser creates (or renames) a person from an export. They sign
-- in later with Cenacle ID under the same verified address (ClaimImportedUser).
INSERT INTO users (auth_service, auth_data, email, display_name)
VALUES ('import', @auth_data, @email, @display_name)
ON CONFLICT ON CONSTRAINT users_auth_key DO UPDATE SET display_name = EXCLUDED.display_name
RETURNING *;

-- name: ClaimImportedUser :one
-- ClaimImportedUser gives an imported person's account to the identity that
-- signs in with their verified address for the first time.
UPDATE users SET auth_service = @auth_service, auth_data = @auth_data, email_verified = true,
    display_name = @display_name, last_login_at = now(), updated_at = now()
WHERE id = (SELECT u.id FROM users u WHERE u.auth_service = 'import' AND u.email <> ''
            AND lower(u.email) = lower(@email) ORDER BY u.created_at LIMIT 1)
RETURNING *;

-- name: FindWorkspaceByName :one
SELECT * FROM workspaces WHERE lower(name) = lower(@name) ORDER BY created_at LIMIT 1;

-- name: ImportMessage :execrows
-- ImportMessage stores a message from an export with its original time (its
-- id is made from that time, shift = created_at - now(), so it sorts into the
-- history); importing the
-- same message again does nothing.
INSERT INTO messages (id, channel_id, author_id, body, nonce, created_at)
VALUES (uuidv7(sqlc.arg(shift)::interval), @channel_id, @author_id, @body, @nonce, @created_at)
ON CONFLICT ON CONSTRAINT messages_author_nonce_key DO NOTHING;

-- name: MarkChannelReadForAll :exec
-- MarkChannelReadForAll makes the history of an imported channel read.
UPDATE channel_members SET last_read_id = (
    SELECT m.id FROM messages m WHERE m.channel_id = @channel_id ORDER BY m.id DESC LIMIT 1)
WHERE channel_id = @channel_id;

-- name: SetWorkspaceMemberRole :exec
UPDATE workspace_members SET role = @role WHERE workspace_id = @workspace_id AND user_id = @user_id;

-- name: GetInstanceAdmin :one
SELECT * FROM users WHERE is_admin ORDER BY created_at LIMIT 1;

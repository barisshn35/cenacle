-- name: FindUserByEmail :one
-- FindUserByEmail finds the account of an address (a person who signed in
-- already wins over an earlier import). A signed-in account counts only with
-- a verified address: an export must not name anyone's account by a claim.
SELECT * FROM users WHERE email <> '' AND lower(email) = lower(@email)
    AND (email_verified OR auth_service = 'import')
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

-- name: ImportMessage :one
-- ImportMessage stores a message from an export with its original time (its
-- id is made from that time, shift = created_at - now(), so it sorts into the
-- history); importing the same message again stores nothing (no row).
INSERT INTO messages (id, channel_id, author_id, body, nonce, created_at, root_id, also_in_channel,
    pinned_at, pinned_by, title, tags, has_files)
VALUES (uuidv7(sqlc.arg(shift)::interval), @channel_id, @author_id, @body, @nonce, @created_at,
    sqlc.narg(root_id), @also_in_channel, sqlc.narg(pinned_at), sqlc.narg(pinned_by), sqlc.narg(title),
    @tags::text[], @has_files)
ON CONFLICT ON CONSTRAINT messages_author_nonce_key DO NOTHING
RETURNING id;

-- name: FindImportedMessage :one
-- FindImportedMessage finds a message imported before (for its replies).
SELECT id FROM messages WHERE author_id = @author_id AND nonce = @nonce;

-- name: ImportReaction :exec
INSERT INTO message_reactions (message_id, emoji, user_id, created_at)
VALUES (@message_id, @emoji, @user_id, @created_at)
ON CONFLICT DO NOTHING;

-- name: ImportFile :one
-- ImportFile records a file of an imported message; its bytes are stored and
-- checked next (status uploading until then).
INSERT INTO files (workspace_id, channel_id, uploader_id, message_id, attached_at, name, content_type, size, created_at)
VALUES (@workspace_id, @channel_id, @uploader_id, @message_id, @created_at, @name, @content_type, @size, @created_at)
RETURNING *;

-- name: FollowImportedThreads :exec
-- FollowImportedThreads makes the authors of imported threads follow them,
-- read to the end.
INSERT INTO thread_follows (user_id, root_id, last_read_id)
SELECT p.user_id, p.root_id,
    (SELECT x.id FROM messages x WHERE x.root_id = p.root_id ORDER BY x.id DESC LIMIT 1)
FROM (
    SELECT r.author_id AS user_id, r.root_id FROM messages r
    WHERE r.channel_id = @channel_id AND r.root_id IS NOT NULL
    UNION
    SELECT root.author_id, root.id FROM messages root
    WHERE root.channel_id = @channel_id
      AND EXISTS (SELECT 1 FROM messages r WHERE r.root_id = root.id)
) p
ON CONFLICT DO NOTHING;

-- name: MarkChannelReadForAll :exec
-- MarkChannelReadForAll makes the history of an imported channel read.
UPDATE channel_members SET last_read_id = (
    SELECT m.id FROM messages m WHERE m.channel_id = @channel_id ORDER BY m.id DESC LIMIT 1)
WHERE channel_id = @channel_id;

-- name: SetWorkspaceMemberRole :exec
UPDATE workspace_members SET role = @role WHERE workspace_id = @workspace_id AND user_id = @user_id;

-- name: GetInstanceAdmin :one
SELECT * FROM users WHERE is_admin ORDER BY created_at LIMIT 1;

-- name: MarkWorkspaceImported :exec
-- MarkWorkspaceImported records that an import created the workspace.
INSERT INTO imported_workspaces (workspace_id) VALUES (@workspace_id) ON CONFLICT DO NOTHING;

-- name: IsWorkspaceImported :one
SELECT EXISTS (SELECT 1 FROM imported_workspaces WHERE workspace_id = @workspace_id);

-- name: MarkChannelImported :exec
-- MarkChannelImported records that an import created the channel.
INSERT INTO imported_channels (channel_id) VALUES (@channel_id) ON CONFLICT DO NOTHING;

-- name: IsChannelImported :one
SELECT EXISTS (SELECT 1 FROM imported_channels WHERE channel_id = @channel_id);

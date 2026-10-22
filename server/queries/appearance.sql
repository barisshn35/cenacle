-- name: GetAppearance :one
SELECT coalesce((SELECT appearance FROM user_preferences WHERE user_id = @user_id), '{}')::jsonb AS appearance;

-- name: SetAppearance :exec
INSERT INTO user_preferences (user_id, appearance) VALUES (@user_id, @appearance)
ON CONFLICT (user_id) DO UPDATE SET appearance = EXCLUDED.appearance, updated_at = now();

-- name: SetWorkspaceAppearance :exec
UPDATE workspaces SET appearance = @appearance WHERE id = @id;

-- name: ListUserFonts :many
SELECT id, name, format, octet_length(data)::int AS size, created_at FROM user_fonts
WHERE user_id = @user_id ORDER BY created_at;

-- name: CountUserFonts :one
SELECT count(*)::int FROM user_fonts WHERE user_id = @user_id;

-- name: InsertUserFont :one
INSERT INTO user_fonts (user_id, name, format, data) VALUES (@user_id, @name, @format, @data)
RETURNING id, name, format, octet_length(data)::int AS size, created_at;

-- name: GetUserFont :one
SELECT id, user_id, format, data FROM user_fonts WHERE id = @id;

-- name: DeleteUserFont :execrows
DELETE FROM user_fonts WHERE id = @id AND user_id = @user_id;

-- name: ListUITexts :many
SELECT key, locale, value FROM ui_texts ORDER BY key, locale;

-- name: DeleteUITexts :exec
DELETE FROM ui_texts WHERE locale = @locale;

-- name: InsertUIText :exec
INSERT INTO ui_texts (key, locale, value) VALUES (@key, @locale, @value);

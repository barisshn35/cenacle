-- name: GetInstanceSettings :one
SELECT web_app FROM instance_settings;

-- name: SetWebApp :exec
INSERT INTO instance_settings (id, web_app, updated_at) VALUES (true, @web_app, now())
ON CONFLICT (id) DO UPDATE SET web_app = EXCLUDED.web_app, updated_at = now();

-- name: GetInstanceSettings :one
SELECT web_app FROM instance_settings;

-- name: SetWebApp :exec
INSERT INTO instance_settings (id, web_app, updated_at) VALUES (true, @web_app, now())
ON CONFLICT (id) DO UPDATE SET web_app = EXCLUDED.web_app, updated_at = now();

-- name: GetMailServer :one
SELECT smtp_host, smtp_port, smtp_security, smtp_username, smtp_password, smtp_from
FROM instance_settings;

-- name: SetMailServer :exec
UPDATE instance_settings SET smtp_host = @host, smtp_port = @port, smtp_security = @security,
    smtp_username = @username, smtp_password = @password, smtp_from = @sender, updated_at = now();

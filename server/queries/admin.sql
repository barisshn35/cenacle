-- name: InstanceCounts :one
-- InstanceCounts summarizes the installation (support bundle, status).
SELECT
    (SELECT count(*) FROM users WHERE NOT is_bot)                     AS people,
    (SELECT count(*) FROM users WHERE is_bot)                         AS bots,
    (SELECT count(*) FROM workspaces)                                 AS workspaces,
    (SELECT count(*) FROM channels)                                   AS channels,
    (SELECT count(*) FROM messages WHERE deleted_at IS NULL)          AS messages,
    (SELECT count(*) FROM files WHERE status = 'ready')               AS files,
    (SELECT coalesce(sum(size), 0)::bigint FROM files WHERE status = 'ready') AS file_bytes,
    (SELECT count(*) FROM sessions WHERE expires_at > now())          AS sessions,
    (SELECT count(*) FROM event_outbox)                               AS outbox_backlog,
    (SELECT count(*) FROM event_deliveries WHERE status = 'pending')  AS deliveries_pending,
    (SELECT count(*) FROM event_deliveries WHERE status = 'failed')   AS deliveries_failed,
    (SELECT count(*) FROM scheduled_messages WHERE status = 'pending') AS scheduled_pending;

-- name: GetNotificationPolicy :one
SELECT push_contents, email_contents FROM instance_settings;

-- name: SetNotificationPolicy :exec
UPDATE instance_settings SET push_contents = @push_contents, email_contents = @email_contents, updated_at = now();

-- name: ActiveUserCount :one
-- ActiveUserCount counts the people seen in the last 30 days. last_seen_at is
-- written when someone goes offline, so a sign-in counts too (online since).
SELECT count(*)::bigint FROM users
WHERE NOT is_bot AND deactivated_at IS NULL
  AND (last_seen_at > now() - interval '30 days' OR last_login_at > now() - interval '30 days');

-- name: AdminListUsers :many
-- AdminListUsers lists the installation's people by name, after a cursor,
-- with what the system console shows about them.
SELECT u.id, u.display_name, u.email, coalesce(u.username, '')::text AS username, u.is_admin,
       coalesce(u.directory_role, '')::text AS directory_role, u.deactivated_at,
       u.last_seen_at, u.last_login_at, u.created_at,
       (u.auth_service = 'erased') AS erased,
       (SELECT count(*) FROM workspace_members wm WHERE wm.user_id = u.id)::int AS workspaces,
       (SELECT count(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > now())::int AS sessions
FROM users u
WHERE NOT u.is_bot
  AND (@q::text = '' OR u.display_name ILIKE '%' || @q || '%' OR u.email ILIKE '%' || @q || '%'
       OR coalesce(u.username, '') ILIKE '%' || @q || '%')
  AND (sqlc.narg(after_name)::text IS NULL
       OR (lower(u.display_name), u.id) > (sqlc.narg(after_name)::text, sqlc.narg(after_id)::uuid))
ORDER BY lower(u.display_name), u.id
LIMIT 50;

-- name: AdminListWorkspaces :many
SELECT w.id, w.name, w.is_default, w.created_at,
       (SELECT count(*) FROM workspace_members wm WHERE wm.workspace_id = w.id)::int AS members,
       (SELECT count(*) FROM channels c WHERE c.workspace_id = w.id AND c.kind NOT IN ('direct', 'group'))::int AS channels
FROM workspaces w
ORDER BY w.is_default DESC, lower(w.name);

-- name: AdminListBots :many
SELECT b.id, u.display_name AS name, b.workspace_id, w.name AS workspace_name, b.disabled_at,
       b.interactions_url, b.created_at
FROM bots b JOIN users u ON u.id = b.user_id JOIN workspaces w ON w.id = b.workspace_id
WHERE NOT b.is_system
ORDER BY lower(w.name), lower(u.display_name);

-- name: GetSessionPolicy :one
SELECT session_max_hours, session_idle_minutes, guest_session_max_hours, guest_idle_minutes,
       admin_networks, signin_networks
FROM instance_settings;

-- name: SetSessionPolicy :exec
UPDATE instance_settings SET session_max_hours = @session_max_hours, session_idle_minutes = @session_idle_minutes,
    guest_session_max_hours = @guest_session_max_hours, guest_idle_minutes = @guest_idle_minutes,
    admin_networks = @admin_networks, signin_networks = @signin_networks, updated_at = now();

-- name: GetFederationPolicy :one
SELECT federation_mode, federation_servers FROM instance_settings;

-- name: SetFederationPolicy :exec
UPDATE instance_settings SET federation_mode = @federation_mode, federation_servers = @federation_servers, updated_at = now();

-- name: GetSoundDefaults :one
SELECT sound_mention, sound_direct, sound_message, sound_volume FROM instance_settings;

-- name: SetSoundDefaults :exec
UPDATE instance_settings
SET sound_mention = @sound_mention, sound_direct = @sound_direct, sound_message = @sound_message,
    sound_volume = @sound_volume, updated_at = now();

-- name: ApplySoundDefaults :execrows
-- ApplySoundDefaults gives everyone who saved their own settings the
-- installation's sounds and volume; their other settings stay.
UPDATE notification_prefs
SET prefs = jsonb_set(jsonb_set(prefs, '{sounds}', jsonb_build_object(
        'mention', @sound_mention::text, 'direct', @sound_direct::text, 'message', @sound_message::text)),
      '{volume}', to_jsonb(@sound_volume::int)),
    updated_at = now();

-- name: DesktopAppVersions :many
-- DesktopAppVersions counts the devices signed in with the desktop app, by its
-- version (from its user agent, "CenacleDesktop/<version>") and system.
SELECT coalesce(substring(user_agent from 'CenacleDesktop/([0-9A-Za-z.+-]{1,40})'), '')::text AS version,
       (CASE WHEN user_agent LIKE '%Windows%' THEN 'windows'
             WHEN user_agent LIKE '%Linux%' THEN 'linux'
             ELSE 'other' END)::text AS platform,
       count(*)::bigint AS devices
FROM sessions
WHERE expires_at > now() AND user_agent LIKE '%CenacleDesktop/%'
GROUP BY 1, 2
ORDER BY 1 DESC, 2;

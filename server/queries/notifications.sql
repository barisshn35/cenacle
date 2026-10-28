-- name: GetNotificationPrefs :one
SELECT coalesce((SELECT prefs FROM notification_prefs WHERE user_id = @user_id), '{}')::jsonb AS prefs;

-- name: SetNotificationPrefs :exec
INSERT INTO notification_prefs (user_id, prefs) VALUES (@user_id, @prefs)
ON CONFLICT (user_id) DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = now();

-- name: ListChannelNotificationPrefs :many
SELECT channel_id, level, muted_until, sound FROM channel_notification_prefs
WHERE user_id = @user_id AND (level <> 'default' OR muted_until IS NOT NULL OR sound <> '');

-- name: SetChannelNotificationPrefs :exec
INSERT INTO channel_notification_prefs (user_id, channel_id, level, muted_until, sound)
VALUES (@user_id, @channel_id, @level, sqlc.narg(muted_until), @sound)
ON CONFLICT (user_id, channel_id) DO UPDATE SET
    level = EXCLUDED.level, muted_until = EXCLUDED.muted_until, sound = EXCLUDED.sound;

-- name: ListWorkspaceNotificationPrefs :many
SELECT workspace_id, muted_until FROM workspace_notification_prefs
WHERE user_id = @user_id AND muted_until IS NOT NULL;

-- name: SetWorkspaceNotificationPrefs :exec
INSERT INTO workspace_notification_prefs (user_id, workspace_id, muted_until)
VALUES (@user_id, @workspace_id, sqlc.narg(muted_until))
ON CONFLICT (user_id, workspace_id) DO UPDATE SET muted_until = EXCLUDED.muted_until;

-- name: ListUserSounds :many
SELECT id, name, content_type, octet_length(data)::int AS size, created_at FROM user_sounds
WHERE user_id = @user_id ORDER BY created_at;

-- name: CountUserSounds :one
SELECT count(*)::int FROM user_sounds WHERE user_id = @user_id;

-- name: InsertUserSound :one
INSERT INTO user_sounds (user_id, name, content_type, data) VALUES (@user_id, @name, @content_type, @data)
RETURNING id, name, content_type, octet_length(data)::int AS size, created_at;

-- name: GetUserSound :one
SELECT user_id, content_type, data FROM user_sounds WHERE id = @id;

-- name: DeleteUserSound :execrows
DELETE FROM user_sounds WHERE id = @id AND user_id = @user_id;

-- name: AddPushSubscription :execrows
-- AddPushSubscription binds a browser's subscription to the session that made
-- it. An endpoint moves to another person only once its session has ended.
INSERT INTO push_subscriptions (user_id, session_id, endpoint, p256dh, auth)
VALUES (@user_id, @session_id, @endpoint, @p256dh, @auth)
ON CONFLICT (endpoint) DO UPDATE
SET user_id = EXCLUDED.user_id, session_id = EXCLUDED.session_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth
WHERE push_subscriptions.user_id = EXCLUDED.user_id
   OR NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = push_subscriptions.session_id AND s.expires_at > now());

-- name: RemovePushSubscription :exec
DELETE FROM push_subscriptions WHERE endpoint = @endpoint AND user_id = @user_id;

-- name: RemovePushEndpoint :exec
DELETE FROM push_subscriptions WHERE endpoint = @endpoint;

-- name: CountPushSubscriptions :one
SELECT count(*)::int FROM push_subscriptions WHERE user_id = @user_id;

-- name: ListPushSubscriptions :many
SELECT p.endpoint, p.p256dh, p.auth FROM push_subscriptions p JOIN sessions s ON s.id = p.session_id
WHERE p.user_id = @user_id AND s.expires_at > now();

-- name: GetPushKeys :one
SELECT public_key, private_key FROM push_keys WHERE id;

-- name: InsertPushKeys :exec
INSERT INTO push_keys (public_key, private_key) VALUES (@public_key, @private_key) ON CONFLICT DO NOTHING;

-- name: NotifyCandidates :many
-- NotifyCandidates lists, for messages after a cursor, the people who may be
-- told about them: the members of the message's channel other than its author,
-- what the message is to them (a mention, a conversation, any message) and
-- their channel and workspace settings. A reply kept in its thread is only for
-- the people it mentions and those following the thread, as a mention.
SELECT m.id AS message_id, m.channel_id,
    (CASE WHEN m.burn_seconds IS NULL AND NOT c.encrypted THEN m.body ELSE '' END)::text AS body, m.created_at, c.name AS channel_name, c.kind AS channel_kind,
       c.workspace_id, a.display_name AS author_name,
       cm.user_id, (mm.user_id IS NOT NULL OR coalesce(tf.following, false))::boolean AS mentioned,
       coalesce(cnp.level, 'default')::text AS level, cnp.muted_until AS channel_muted_until,
       wnp.muted_until AS workspace_muted_until
FROM messages m
JOIN channels c ON c.id = m.channel_id
JOIN users a ON a.id = m.author_id
JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id <> m.author_id
JOIN users u ON u.id = cm.user_id AND NOT u.is_bot AND u.deactivated_at IS NULL
LEFT JOIN message_mentions mm ON mm.message_id = m.id AND mm.user_id = cm.user_id
LEFT JOIN thread_follows tf ON tf.root_id = m.root_id AND tf.user_id = cm.user_id
LEFT JOIN channel_notification_prefs cnp ON cnp.user_id = cm.user_id AND cnp.channel_id = m.channel_id
LEFT JOIN workspace_notification_prefs wnp ON wnp.user_id = cm.user_id AND wnp.workspace_id = c.workspace_id
WHERE m.id > @after AND m.deleted_at IS NULL AND m.created_at > now() - interval '1 day'
  AND (CASE WHEN m.root_id IS NULL OR m.also_in_channel
            THEN cm.last_read_id IS NULL OR cm.last_read_id < m.id
            ELSE (mm.user_id IS NOT NULL OR coalesce(tf.following, false))
                 AND (tf.last_read_id IS NULL OR tf.last_read_id < m.id) END)
ORDER BY m.id
LIMIT @row_limit;

-- name: NewestMessageID :one
SELECT coalesce((SELECT id FROM messages ORDER BY id DESC LIMIT 1), '00000000-0000-0000-0000-000000000000'::uuid)::uuid;

-- name: UsersForNotifying :many
SELECT u.id, u.email, u.email_verified, u.display_name, u.timezone, coalesce(np.prefs, '{}')::jsonb AS prefs
FROM users u LEFT JOIN notification_prefs np ON np.user_id = u.id
WHERE u.id = ANY(@ids::uuid[]);

-- name: GetEmailNotification :one
SELECT last_message, sent_at FROM email_notifications WHERE user_id = @user_id;

-- name: SetEmailNotification :exec
INSERT INTO email_notifications (user_id, last_message, sent_at) VALUES (@user_id, @last_message, now())
ON CONFLICT (user_id) DO UPDATE SET last_message = EXCLUDED.last_message, sent_at = now();

-- name: GetNotifyCursor :one
SELECT cursor FROM notify_cursors WHERE name = @name;

-- name: SetNotifyCursor :exec
INSERT INTO notify_cursors (name, cursor) VALUES (@name, @cursor)
ON CONFLICT (name) DO UPDATE SET cursor = EXCLUDED.cursor;

-- name: EmailRecipients :many
-- EmailRecipients are people who want e-mail about what they missed and have
-- a verified address.
SELECT u.id FROM users u JOIN notification_prefs np ON np.user_id = u.id
WHERE (np.prefs -> 'email' ->> 'enabled')::boolean AND u.email <> '' AND u.email_verified
  AND u.deactivated_at IS NULL AND NOT u.is_bot;

-- name: MissedForEmail :many
-- MissedForEmail lists unread mentions, conversation messages and replies in
-- followed threads of a person after a message id and older than a moment,
-- oldest first.
SELECT m.id AS message_id, m.channel_id,
    (CASE WHEN m.burn_seconds IS NULL AND NOT c.encrypted THEN m.body ELSE '' END)::text AS body, m.created_at, c.name AS channel_name, c.kind AS channel_kind,
       c.workspace_id, a.display_name AS author_name,
       (mm.user_id IS NOT NULL OR coalesce(tf.following, false))::boolean AS mentioned,
       coalesce(cnp.level, 'default')::text AS level, cnp.muted_until AS channel_muted_until,
       wnp.muted_until AS workspace_muted_until
FROM channel_members cm
JOIN messages m ON m.channel_id = cm.channel_id AND m.author_id <> cm.user_id
JOIN channels c ON c.id = m.channel_id
JOIN users a ON a.id = m.author_id
LEFT JOIN message_mentions mm ON mm.message_id = m.id AND mm.user_id = cm.user_id
LEFT JOIN thread_follows tf ON tf.root_id = m.root_id AND tf.user_id = cm.user_id
LEFT JOIN channel_notification_prefs cnp ON cnp.user_id = cm.user_id AND cnp.channel_id = m.channel_id
LEFT JOIN workspace_notification_prefs wnp ON wnp.user_id = cm.user_id AND wnp.workspace_id = c.workspace_id
WHERE cm.user_id = @user_id AND m.deleted_at IS NULL
  AND (CASE WHEN m.root_id IS NULL OR m.also_in_channel
            THEN (mm.user_id IS NOT NULL OR c.kind IN ('direct', 'group'))
                 AND (cm.last_read_id IS NULL OR cm.last_read_id < m.id)
            ELSE (mm.user_id IS NOT NULL OR coalesce(tf.following, false))
                 AND (tf.last_read_id IS NULL OR tf.last_read_id < m.id) END)
  AND m.id > @after AND m.created_at < @older_than AND m.created_at > now() - interval '7 days'
ORDER BY m.id
LIMIT 50;

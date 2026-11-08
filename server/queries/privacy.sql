-- name: UserMessagesAfter :many
-- UserMessagesAfter returns the messages a person wrote, oldest first, after a
-- cursor (their data export).
SELECT m.id, m.channel_id, c.name AS channel_name, m.root_id, m.body, m.created_at, m.edited_at, m.deleted_at, m.has_files
FROM messages m JOIN channels c ON c.id = m.channel_id
WHERE m.author_id = @author_id AND (sqlc.narg(after)::uuid IS NULL OR m.id > sqlc.narg(after)::uuid)
ORDER BY m.id
LIMIT @row_limit;

-- name: UserWorkspaces :many
SELECT w.id, w.name, wm.role FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id
WHERE wm.user_id = @user_id ORDER BY lower(w.name);

-- name: UserChannels :many
SELECT c.id, c.name, c.kind, c.workspace_id, cm.role FROM channel_members cm JOIN channels c ON c.id = cm.channel_id
WHERE cm.user_id = @user_id ORDER BY c.id;

-- name: UserReactions :many
SELECT message_id, emoji, created_at FROM message_reactions WHERE user_id = @user_id ORDER BY created_at;

-- name: UserFiles :many
SELECT id, channel_id, message_id, name, content_type, size, status, created_at FROM files
WHERE uploader_id = @user_id ORDER BY id;

-- name: UserSessionsAll :many
SELECT created_at, last_seen_at, expires_at, user_agent, ip_address FROM sessions WHERE user_id = @user_id ORDER BY id;

-- name: UserAuditEvents :many
SELECT id, at, action, workspace_id, target_type, target_id, ip_address, detail FROM audit_events
WHERE actor_id = @user_id ORDER BY id;

-- name: EraseUserMessages :one
-- EraseUserMessages deletes a person's messages (the purge removes them for good
-- within the restore window). Those a legal hold keeps are marked deleted too,
-- so nobody sees them, and keep their text and edits for eDiscovery; the purge
-- removes them once the hold no longer keeps them.
WITH erased AS (
    UPDATE messages m SET deleted_at = coalesce(m.deleted_at, now()), deleted_by = coalesce(m.deleted_by, @erased_by)
    WHERE m.author_id = @user_id
    RETURNING m.id, message_held(m.channel_id, m.author_id, m.created_at) AS held
), edits AS (
    DELETE FROM message_edits WHERE message_id IN (SELECT id FROM erased WHERE NOT held) RETURNING 1
)
SELECT (SELECT count(*) FROM erased WHERE NOT held)::int AS erased,
       (SELECT count(*) FROM erased WHERE held)::int AS held,
       (SELECT count(*) FROM edits)::int AS edits;

-- name: EmitErasedMessages :one
-- EmitErasedMessages records message.deleted for every message the erasure has
-- just deleted (deleted_at is the transaction's time), all at once: for open
-- apps (the outbox), for the bots subscribed in the message's channel and for
-- the servers the channel is shared with, as emit would one by one.
WITH gone AS (
    SELECT m.id, m.channel_id,
           jsonb_strip_nulls(jsonb_build_object('id', m.id, 'channel_id', m.channel_id, 'root_id', m.root_id)) AS data
    FROM messages m
    WHERE m.author_id = @user_id AND m.deleted_at = now()
), origin AS (
    -- A person who came over a connection: their events do not go back to it.
    SELECT split_part(u.auth_data, ':', 1) AS connection FROM users u
    WHERE u.id = @user_id AND u.auth_service = 'remote'
), outbox AS (
    INSERT INTO event_outbox (type, data)
    SELECT 'message.deleted', g.data FROM gone g ORDER BY g.id
    RETURNING 1
), bots AS (
    INSERT INTO event_deliveries (subscription_id, event_type, payload)
    SELECT s.id, 'message.deleted', g.data
    FROM gone g
    JOIN channel_members cm ON cm.channel_id = g.channel_id
    JOIN bots b ON b.user_id = cm.user_id AND b.disabled_at IS NULL
    JOIN event_subscriptions s ON s.bot_id = b.id AND s.disabled_at IS NULL AND 'message.deleted' = ANY (s.events)
    ORDER BY g.id
    RETURNING 1
), servers AS (
    INSERT INTO federation_deliveries (connection_id, event)
    SELECT sc.connection_id, jsonb_build_object('type', 'message.deleted', 'channel_id', sc.remote_channel_id,
               'message', CASE WHEN fm.remote_message_id IS NULL THEN jsonb_build_object('ours', g.id)
                               ELSE jsonb_build_object('yours', fm.remote_message_id) END)
    FROM gone g
    JOIN shared_channels sc ON sc.channel_id = g.channel_id AND sc.status = 'active'
    JOIN federation_connections f ON f.id = sc.connection_id AND f.status IN ('active', 'disabled')
    LEFT JOIN federated_messages fm ON fm.connection_id = sc.connection_id AND fm.message_id = g.id
    WHERE sc.connection_id::text IS DISTINCT FROM (SELECT connection FROM origin)
    ORDER BY g.id
    RETURNING 1
), wake AS (
    SELECT pg_notify('cenacle_outbox', '') WHERE EXISTS (SELECT 1 FROM outbox)
)
SELECT (SELECT count(*) FROM outbox)::int AS events,
       (SELECT count(*) FROM bots)::int AS bot_deliveries,
       (SELECT count(*) FROM servers)::int AS server_deliveries,
       (SELECT count(*) FROM wake)::int AS woken;

-- name: LockUserAvatar :one
-- LockUserAvatar returns a person's profile picture, holding the row until the
-- erasure commits.
SELECT avatar_id FROM users WHERE id = @id FOR UPDATE;

-- name: DeletePictureIfUnused :execrows
-- DeletePictureIfUnused removes a picture nothing shows any more.
DELETE FROM pictures p WHERE p.id = @id
  AND NOT EXISTS (SELECT 1 FROM users u WHERE u.avatar_id = p.id)
  AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.icon_id = p.id)
  AND NOT EXISTS (SELECT 1 FROM link_previews l WHERE l.image_id = p.id)
  AND NOT EXISTS (SELECT 1 FROM custom_emoji e WHERE e.picture_id = p.id)
  AND NOT EXISTS (SELECT 1 FROM stickers s WHERE s.picture_id = p.id);

-- name: EraseUserDeliveries :one
-- EraseUserDeliveries removes the queued bot and federation deliveries of a
-- person's messages (also those a legal hold keeps: the hold keeps the message,
-- not copies on their way out) and the bot deliveries of their reactions.
WITH bots AS (
    DELETE FROM event_deliveries d
    WHERE d.message_id IN (SELECT m.id FROM messages m WHERE m.author_id = @user_id)
       OR (d.event_type IN ('reaction.added', 'reaction.removed') AND d.payload ->> 'user_id' = (@user_id::uuid)::text)
    RETURNING 1
), servers AS (
    DELETE FROM federation_deliveries f
    WHERE f.message_id IN (SELECT m.id FROM messages m WHERE m.author_id = @user_id)
    RETURNING 1
)
SELECT ((SELECT count(*) FROM bots) + (SELECT count(*) FROM servers))::int AS removed;

-- name: EraseUserTraces :exec
-- EraseUserTraces removes what a person kept or set for themselves.
SELECT erase_user_traces(@user_id::uuid);

-- name: EraseUserAuditEvents :execrows
-- EraseUserAuditEvents blanks the address (IP) of the audit events a person did
-- and keeps only the neutral parts of their detail; who did what and when stays.
UPDATE audit_events SET ip_address = '', detail = coalesce(
    (SELECT jsonb_object_agg(k, v) FROM jsonb_each(detail) AS e(k, v) WHERE k = ANY(@neutral::text[])),
    '{}')
WHERE actor_id = @user_id;

-- name: EraseUser :one
-- EraseUser anonymizes an account: no name, address, picture or status; it can
-- no longer sign in (a new sign-in makes a new account).
UPDATE users SET display_name = @display_name, email = '', email_verified = false, username = NULL,
    avatar_id = NULL, avatar_from_directory = false, directory_photo = '', timezone = '',
    status_emoji = '', status_text = '', status_expires_at = NULL, recent_statuses = '[]',
    auth_service = 'erased', auth_data = 'erased:' || id::text, directory_role = NULL, is_admin = false,
    deactivated_at = coalesce(deactivated_at, now()), last_seen_at = NULL, updated_at = now()
WHERE id = @id AND NOT is_bot
RETURNING *;

-- name: UserExportRows :many
-- UserExportRows returns the rest of what is stored about a person for their
-- data export, one row per item: what they wrote or set, what they made, and
-- what was recorded about them. Secrets (token and password hashes, signing and
-- push keys, end-to-end key material) stay out; the bytes of their uploaded
-- fonts and sounds and of their profile picture are in base64.
SELECT 'message_version'::text AS kind,
       jsonb_build_object('message_id', e.message_id, 'body', e.body, 'written_at', e.written_at, 'replaced_at', e.replaced_at) AS data
FROM message_edits e JOIN messages m ON m.id = e.message_id WHERE m.author_id = @user_id
UNION ALL SELECT 'scheduled_message', to_jsonb(s) FROM scheduled_messages s WHERE s.owner_id = @user_id OR s.author_id = @user_id
UNION ALL SELECT 'form_submission', to_jsonb(f) FROM form_submissions f WHERE f.user_id = @user_id
UNION ALL SELECT 'poll_vote', to_jsonb(v) FROM poll_votes v WHERE v.user_id = @user_id
UNION ALL SELECT 'event_rsvp', to_jsonb(r) FROM event_rsvps r WHERE r.user_id = @user_id
UNION ALL SELECT 'report', to_jsonb(r) FROM message_reports r WHERE r.reporter_id = @user_id
UNION ALL SELECT 'spillage_report', to_jsonb(r) FROM spillage_reports r WHERE r.reported_by = @user_id
UNION ALL SELECT 'saved_message', to_jsonb(s) FROM saved_messages s WHERE s.user_id = @user_id
UNION ALL SELECT 'thread_follow', to_jsonb(t) FROM thread_follows t WHERE t.user_id = @user_id
UNION ALL SELECT 'acknowledgement', to_jsonb(a) FROM message_acks a WHERE a.user_id = @user_id
UNION ALL SELECT 'reminder', to_jsonb(r) FROM message_reminders r WHERE r.user_id = @user_id
UNION ALL SELECT 'mention', to_jsonb(x) FROM message_mentions x WHERE x.user_id = @user_id
UNION ALL SELECT 'burn_reveal', to_jsonb(b) FROM burn_reveals b WHERE b.user_id = @user_id
UNION ALL SELECT 'ai_request', to_jsonb(a) FROM ai_requests a WHERE a.user_id = @user_id
UNION ALL SELECT 'dialog', to_jsonb(d) FROM dialogs d WHERE d.user_id = @user_id
UNION ALL SELECT 'mention_group_member', to_jsonb(g) FROM mention_group_members g WHERE g.user_id = @user_id
UNION ALL SELECT 'workflow_run_started', to_jsonb(w) FROM workflow_runs w WHERE w.trigger_user_id = @user_id
UNION ALL SELECT 'workflow_task_done', to_jsonb(w) FROM workflow_tasks w WHERE w.done_by = @user_id
UNION ALL SELECT 'playbook_run_owned', to_jsonb(p) FROM playbook_runs p WHERE p.owner_id = @user_id
-- Settings.
UNION ALL SELECT 'notification_settings', to_jsonb(n) FROM notification_prefs n WHERE n.user_id = @user_id
UNION ALL SELECT 'channel_notification_settings', to_jsonb(n) FROM channel_notification_prefs n WHERE n.user_id = @user_id
UNION ALL SELECT 'workspace_notification_settings', to_jsonb(n) FROM workspace_notification_prefs n WHERE n.user_id = @user_id
UNION ALL SELECT 'appearance', to_jsonb(p) FROM user_preferences p WHERE p.user_id = @user_id
UNION ALL SELECT 'sidebar', to_jsonb(l) FROM sidebar_layouts l WHERE l.user_id = @user_id
UNION ALL SELECT 'email_notification_state', to_jsonb(e) FROM email_notifications e WHERE e.user_id = @user_id
UNION ALL SELECT 'push_subscription', to_jsonb(p) - ARRAY['p256dh', 'auth'] FROM push_subscriptions p WHERE p.user_id = @user_id
UNION ALL SELECT 'encryption_device', to_jsonb(d) - 'signature_key' FROM e2e_devices d WHERE d.user_id = @user_id
UNION ALL SELECT 'encryption_backup', to_jsonb(b) - 'data' FROM e2e_backups b WHERE b.user_id = @user_id
UNION ALL SELECT 'encryption_recovery', jsonb_build_object('created_at', r.created_at) FROM e2e_recovery r WHERE r.user_id = @user_id
UNION ALL SELECT 'font', to_jsonb(f) - 'data' || jsonb_build_object('data_base64', encode(f.data, 'base64')) FROM user_fonts f WHERE f.user_id = @user_id
UNION ALL SELECT 'sound', to_jsonb(s) - 'data' || jsonb_build_object('data_base64', encode(s.data, 'base64')) FROM user_sounds s WHERE s.user_id = @user_id
UNION ALL SELECT 'profile_picture', jsonb_build_object('content_type', p.content_type, 'data_base64', encode(p.data, 'base64'))
FROM users u JOIN pictures p ON p.id = u.avatar_id WHERE u.id = @user_id
-- What they made.
UNION ALL SELECT 'created_event', to_jsonb(e) FROM events e WHERE e.created_by = @user_id
UNION ALL SELECT 'created_form', to_jsonb(f) FROM forms f WHERE f.created_by = @user_id
UNION ALL SELECT 'created_list_item', to_jsonb(i) FROM list_items i WHERE i.created_by = @user_id
UNION ALL SELECT 'edited_canvas', to_jsonb(c) FROM canvases c WHERE c.updated_by = @user_id
UNION ALL SELECT 'created_channel_tab', to_jsonb(t) FROM channel_tabs t WHERE t.created_by = @user_id
UNION ALL SELECT 'created_channel_feed', to_jsonb(f) FROM channel_feeds f WHERE f.created_by = @user_id
UNION ALL SELECT 'created_emoji', to_jsonb(e) FROM custom_emoji e WHERE e.created_by = @user_id
UNION ALL SELECT 'created_sticker', to_jsonb(s) FROM stickers s WHERE s.created_by = @user_id
UNION ALL SELECT 'created_sticker_pack', to_jsonb(k) FROM sticker_packs k WHERE k.created_by = @user_id
UNION ALL SELECT 'created_mention_group', to_jsonb(g) FROM mention_groups g WHERE g.created_by = @user_id
UNION ALL SELECT 'created_playbook', to_jsonb(p) FROM playbooks p WHERE p.created_by = @user_id
UNION ALL SELECT 'created_workflow', to_jsonb(w) - ARRAY['webhook_hash', 'secret'] FROM workflows w WHERE w.created_by = @user_id
UNION ALL SELECT 'created_bot', to_jsonb(b) - 'interactions_secret' FROM bots b WHERE b.created_by = @user_id
UNION ALL SELECT 'created_bot_token', to_jsonb(t) - 'token_hash' FROM bot_tokens t WHERE t.created_by = @user_id
UNION ALL SELECT 'created_slash_command', to_jsonb(c) - 'secret' FROM slash_commands c WHERE c.created_by = @user_id
UNION ALL SELECT 'created_incoming_webhook', to_jsonb(w) - 'token_hash' FROM incoming_webhooks w WHERE w.created_by = @user_id
UNION ALL SELECT 'created_event_subscription', to_jsonb(s) - 'secret' FROM event_subscriptions s WHERE s.created_by = @user_id
UNION ALL SELECT 'created_guest_link', to_jsonb(g) - ARRAY['token_hash', 'password_hash'] FROM guest_links g WHERE g.created_by = @user_id
-- Recorded about them by others (who did it stays out: the actor and their address).
UNION ALL SELECT 'audit_about', jsonb_build_object('at', a.at, 'action', a.action, 'workspace_id', a.workspace_id, 'detail', a.detail)
FROM audit_events a WHERE a.target_type = 'user' AND a.target_id = (@user_id::uuid)::text AND a.actor_id IS DISTINCT FROM @user_id;

-- name: UserFileKeys :many
-- UserFileKeys returns a person's uploaded files whose bytes are stored.
SELECT id, size FROM files WHERE uploader_id = @user_id AND status = 'ready' ORDER BY id;

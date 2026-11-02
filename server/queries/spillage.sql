-- name: CreateSpillageReport :one
INSERT INTO spillage_reports (workspace_id, channel_id, message_id, message_ref, reported_by, reason)
VALUES (@workspace_id, @channel_id, @message_id, @message_id, @reported_by, @reason)
ON CONFLICT (message_ref) WHERE status = 'open' DO NOTHING
RETURNING *;

-- name: ListSpillageReports :many
SELECT r.*, coalesce(c.name, '')::text AS channel_name, coalesce(u.display_name, '')::text AS reporter_name,
       coalesce(d.display_name, '')::text AS decider_name,
       coalesce(a.display_name, '')::text AS author_name, coalesce(m.body, '')::text AS body
FROM spillage_reports r
LEFT JOIN channels c ON c.id = r.channel_id
LEFT JOIN users u ON u.id = r.reported_by
LEFT JOIN users d ON d.id = r.decided_by
LEFT JOIN messages m ON m.id = r.message_id
LEFT JOIN users a ON a.id = m.author_id
WHERE r.workspace_id = @workspace_id AND (@status::text = '' OR r.status = @status::text)
ORDER BY r.id DESC
LIMIT 100;

-- name: GetSpillageReport :one
SELECT * FROM spillage_reports WHERE id = @id;

-- name: DecideSpillageReport :one
UPDATE spillage_reports SET status = @status, decided_by = @decided_by, decided_at = now(), note = @note,
    report = @report
WHERE id = @id AND status = 'open'
RETURNING *;

-- name: SetSpillageReviewers :exec
UPDATE workspaces SET spillage_reviewers = @reviewers WHERE id = @id;

-- name: SpillageExposure :many
-- SpillageExposure is who could see a channel's message when it was removed.
SELECT u.id, u.display_name FROM channel_members cm JOIN users u ON u.id = cm.user_id
WHERE cm.channel_id = @channel_id AND NOT u.is_bot ORDER BY lower(u.display_name);

-- name: RedactMessage :one
-- RedactMessage empties a spilled message and its traces; legal holds do not
-- keep spillage.
WITH m AS (
    UPDATE messages x SET body = '[removed: spillage]', attachments = '[]', title = NULL, link_url = NULL, forward = NULL,
        deleted_at = coalesce(x.deleted_at, now()), deleted_by = @removed_by, edited_at = NULL,
        pinned_at = NULL, pinned_by = NULL
    WHERE x.id = @id
    RETURNING x.id
), edits AS (DELETE FROM message_edits e WHERE e.message_id = @id RETURNING 1),
   reactions AS (DELETE FROM message_reactions r WHERE r.message_id = @id RETURNING 1),
   mentions AS (DELETE FROM message_mentions n WHERE n.message_id = @id RETURNING 1),
   saved AS (DELETE FROM saved_messages s WHERE s.message_id = @id RETURNING s.reminder_id),
   -- A reminder of a saved copy carries an excerpt of the text.
   reminders AS (UPDATE scheduled_messages sm SET status = 'canceled', body = '[removed: spillage]'
                 WHERE sm.id IN (SELECT reminder_id FROM saved WHERE reminder_id IS NOT NULL) AND sm.status = 'pending'
                 RETURNING 1),
   done_reminders AS (UPDATE scheduled_messages sm SET body = '[removed: spillage]'
                 WHERE sm.id IN (SELECT reminder_id FROM saved WHERE reminder_id IS NOT NULL) AND sm.status <> 'pending'
                 RETURNING 1),
   -- Queued bot and federation deliveries carry it too (the deletion that
   -- follows names no content, so it still goes).
   deliveries AS (DELETE FROM event_deliveries d WHERE d.message_id = @id RETURNING 1),
   federated AS (DELETE FROM federation_deliveries f WHERE f.message_id = @id RETURNING 1)
SELECT (SELECT count(*) FROM m)::int AS redacted, (SELECT count(*) FROM edits)::int AS edits,
       (SELECT count(*) FROM reactions)::int AS reactions, (SELECT count(*) FROM mentions)::int AS mentions,
       (SELECT count(*) FROM saved)::int AS saved, (SELECT count(*) FROM reminders)::int AS reminders,
       (SELECT count(*) FROM deliveries)::int AS deliveries, (SELECT count(*) FROM federated)::int AS federated;

-- name: RemoveReminderCopies :many
-- RemoveReminderCopies removes the reminders already sent for saved copies of a
-- spilled message: they quote it. Run before RedactMessage (which drops the saved rows).
UPDATE messages x SET body = '[removed: spillage]', attachments = '[]', title = NULL, link_url = NULL,
    deleted_at = coalesce(x.deleted_at, now()), deleted_by = @removed_by, edited_at = NULL
FROM saved_messages s JOIN scheduled_messages sm ON sm.id = s.reminder_id
WHERE s.message_id = @id AND sm.status = 'sent' AND x.id = sm.message_id
RETURNING x.id, x.channel_id, x.root_id;

-- name: RedactForwardDeliveries :execrows
-- RedactForwardDeliveries empties the snapshot of a spilled message in the
-- queued bot deliveries of the messages that forwarded it.
UPDATE event_deliveries d SET payload = jsonb_set(d.payload, '{forward,body}', to_jsonb('[removed: spillage]'::text))
FROM messages f
WHERE f.id = d.message_id AND f.forward ->> 'message_id' = (@id::uuid)::text
  AND d.payload -> 'forward' ->> 'message_id' = (@id::uuid)::text;

-- name: RedactForwardCopies :many
-- RedactForwardCopies empties the snapshot of a spilled message in the
-- messages that forwarded it.
UPDATE messages f SET forward = jsonb_set(f.forward, '{body}', to_jsonb('[removed: spillage]'::text))
WHERE f.forward IS NOT NULL AND f.forward ->> 'message_id' = (@id::uuid)::text
RETURNING *;

-- name: DetachMessageFiles :many
DELETE FROM files WHERE message_id = @message_id RETURNING id, name, size, content_type;

-- name: RedactRunMessages :many
-- RedactRunMessages empties what workflow runs (nonce prefixes wf-<run>-)
-- posted as the system bot; task cards carry no text and stay.
UPDATE messages m SET body = '[removed: spillage]', attachments = '[]', title = NULL, link_url = NULL,
    deleted_at = coalesce(m.deleted_at, now()), deleted_by = @removed_by, edited_at = NULL,
    pinned_at = NULL, pinned_by = NULL
WHERE m.author_id = @bot_id AND m.task_id IS NULL AND m.nonce LIKE ANY (@prefixes::text[])
RETURNING m.id, m.channel_id, m.root_id;

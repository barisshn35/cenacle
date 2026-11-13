-- Meetings and calendar (ADR 0054).

-- name: CreateMeeting :one
INSERT INTO meetings (workspace_id, channel_id, organizer_id, title, agenda, starts_at, ends_at, timezone, rrule, last_start)
VALUES (@workspace_id, @channel_id, @organizer_id, @title, @agenda, @starts_at, @ends_at, @timezone, @rrule, @last_start)
RETURNING *;

-- name: GetMeeting :one
SELECT * FROM meetings WHERE id = @id;

-- name: UpdateMeeting :one
-- A change of time or repeat clears the cancelled occurrences (they no longer
-- match); the sequence grows so calendars take the new version.
UPDATE meetings SET title = @title, agenda = @agenda, starts_at = @starts_at, ends_at = @ends_at,
    timezone = @timezone, rrule = @rrule, last_start = @last_start,
    exdates = CASE WHEN starts_at = @starts_at AND rrule = @rrule THEN exdates ELSE '{}' END,
    sequence = sequence + 1, updated_at = now()
WHERE id = @id AND cancelled_at IS NULL
RETURNING *;

-- name: CancelMeeting :one
UPDATE meetings SET cancelled_at = now(), sequence = sequence + 1, updated_at = now()
WHERE id = @id AND cancelled_at IS NULL
RETURNING *;

-- name: SkipMeetingOccurrence :one
UPDATE meetings SET exdates = array_append(exdates, @occurrence::timestamptz), sequence = sequence + 1, updated_at = now()
WHERE id = @id AND cancelled_at IS NULL AND NOT (@occurrence::timestamptz = ANY(exdates))
RETURNING *;

-- name: AddMeetingInvitee :execrows
INSERT INTO meeting_invitees (meeting_id, user_id, response, responded_at)
VALUES (@meeting_id, @user_id, @response, CASE WHEN @response::text = 'pending' THEN NULL ELSE now() END)
ON CONFLICT DO NOTHING;

-- name: RemoveMeetingInvitee :execrows
DELETE FROM meeting_invitees WHERE meeting_id = @meeting_id AND user_id = @user_id;

-- name: ListMeetingInvitees :many
SELECT i.user_id, i.response, i.responded_at, u.display_name, u.email
FROM meeting_invitees i JOIN users u ON u.id = i.user_id
WHERE i.meeting_id = @meeting_id
ORDER BY (i.user_id = (SELECT organizer_id FROM meetings WHERE id = @meeting_id)) DESC, u.display_name, i.user_id;

-- name: GetMeetingResponse :one
SELECT response FROM meeting_invitees WHERE meeting_id = @meeting_id AND user_id = @user_id;

-- name: SetMeetingResponse :execrows
UPDATE meeting_invitees SET response = @response, responded_at = now()
WHERE meeting_id = @meeting_id AND user_id = @user_id;

-- name: MeetingsForUser :many
-- The meetings a person is invited to that can have an occurrence in the range
-- (a meeting lasts at most a day).
SELECT m.*, i.response, c.name AS channel_name, c.kind AS channel_kind, c.title AS channel_title
FROM meetings m
JOIN meeting_invitees i ON i.meeting_id = m.id AND i.user_id = @user_id
JOIN channels c ON c.id = m.channel_id
WHERE m.starts_at < @until AND m.last_start > sqlc.arg(since)::timestamptz - interval '1 day'
  AND (m.cancelled_at IS NULL OR @with_cancelled::boolean)
ORDER BY m.starts_at, m.id
LIMIT 1000;

-- name: EventsForUser :many
-- Workspace events the person answered going or maybe to, in the range.
SELECT e.id, e.workspace_id, e.channel_id, e.title, e.location, e.starts_at, e.ends_at, r.status
FROM events e JOIN event_rsvps r ON r.event_id = e.id AND r.user_id = @user_id
WHERE e.canceled_at IS NULL AND r.status IN ('going', 'maybe')
  AND e.starts_at < @until AND e.ends_at > @since
ORDER BY e.starts_at
LIMIT 500;

-- name: QueueMeetingMail :exec
INSERT INTO meeting_mails (meeting_id, user_id, kind, was_starts_at, was_ends_at)
VALUES (@meeting_id, @user_id, @kind, sqlc.narg(was_starts_at), sqlc.narg(was_ends_at));

-- name: DueMeetingMails :many
-- E-mails to send now: tried for at most a day. A newer e-mail about the same
-- meeting for the same person replaces an older one still waiting.
SELECT mm.id, mm.kind, mm.was_starts_at, mm.was_ends_at, mm.attempts,
    m.id AS meeting_id, m.title, m.agenda, m.starts_at, m.ends_at, m.timezone, m.rrule, m.exdates, m.sequence,
    m.channel_id, m.workspace_id, m.organizer_id,
    c.name AS channel_name, c.kind AS channel_kind, c.title AS channel_title, w.name AS workspace_name,
    coalesce(o.display_name, '')::text AS organizer_name,
    (CASE WHEN o.email_verified THEN coalesce(o.email, '') ELSE '' END)::text AS organizer_email,
    u.id AS user_id, u.email, u.email_verified, u.display_name, u.timezone AS user_timezone,
    coalesce(u.language, '')::text AS language, coalesce(np.prefs, '{}')::jsonb AS prefs,
    -- Meetings are for the organization: guests get no e-mail about them.
    EXISTS (SELECT 1 FROM workspace_members g WHERE g.workspace_id = m.workspace_id AND g.user_id = mm.user_id
        AND g.role = 'guest')::boolean AS guest,
    -- An invitation not sent yet: the person has not heard of the meeting.
    EXISTS (SELECT 1 FROM meeting_mails o WHERE o.meeting_id = mm.meeting_id AND o.user_id = mm.user_id
        AND o.id < mm.id AND o.sent_at IS NULL AND o.kind = 'invite')::boolean AS unsent_invite
FROM meeting_mails mm
JOIN meetings m ON m.id = mm.meeting_id
JOIN channels c ON c.id = m.channel_id
JOIN workspaces w ON w.id = m.workspace_id
JOIN users u ON u.id = mm.user_id
LEFT JOIN users o ON o.id = m.organizer_id
LEFT JOIN notification_prefs np ON np.user_id = u.id
WHERE mm.sent_at IS NULL AND mm.attempts < 20 AND mm.created_at > now() - interval '1 day'
  AND NOT EXISTS (SELECT 1 FROM meeting_mails n WHERE n.meeting_id = mm.meeting_id AND n.user_id = mm.user_id
      AND n.id > mm.id AND n.sent_at IS NULL)
ORDER BY mm.id
LIMIT 100;

-- name: MarkMeetingMailsSent :exec
-- The e-mail went (or is not for this person); older ones waiting go with it.
UPDATE meeting_mails SET sent_at = now()
WHERE sent_at IS NULL AND meeting_id = @meeting_id AND user_id = @user_id AND id <= @id;

-- name: MeetingMailFailed :exec
UPDATE meeting_mails SET attempts = attempts + 1 WHERE id = @id;

-- name: PruneMeetingMails :exec
DELETE FROM meeting_mails WHERE created_at < now() - interval '7 days';

-- name: MeetingInviteeNames :many
SELECT u.display_name FROM meeting_invitees i JOIN users u ON u.id = i.user_id
WHERE i.meeting_id = @meeting_id AND i.response <> 'no'
ORDER BY (i.user_id = (SELECT organizer_id FROM meetings WHERE id = @meeting_id)) DESC, u.display_name
LIMIT 50;

-- name: CountMeetingInvitees :one
SELECT count(*) FROM meeting_invitees WHERE meeting_id = @meeting_id AND response <> 'no';

-- name: MeetingsSoon :many
-- Meetings that can start within the next quarter of an hour, with the people
-- to remind (all but those who said no).
SELECT m.id, m.title, m.starts_at, m.ends_at, m.timezone, m.rrule, m.exdates, m.channel_id,
    i.user_id, c.workspace_id
FROM meetings m
JOIN meeting_invitees i ON i.meeting_id = m.id AND i.response <> 'no'
JOIN channels c ON c.id = m.channel_id
WHERE m.cancelled_at IS NULL AND m.starts_at <= now() + interval '16 minutes'
  AND m.last_start >= now() - interval '1 minute'
LIMIT 5000;

-- name: AddMeetingReminder :execrows
INSERT INTO meeting_reminders (meeting_id, user_id, occurrence) VALUES (@meeting_id, @user_id, @occurrence)
ON CONFLICT DO NOTHING;

-- name: PruneMeetingReminders :exec
DELETE FROM meeting_reminders WHERE occurrence < now() - interval '2 days';

-- name: SetCalendarFeed :exec
INSERT INTO calendar_feeds (user_id, token_hash) VALUES (@user_id, @token_hash)
ON CONFLICT (user_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, created_at = now();

-- name: GetCalendarFeed :one
SELECT created_at FROM calendar_feeds WHERE user_id = @user_id;

-- name: DeleteCalendarFeed :execrows
DELETE FROM calendar_feeds WHERE user_id = @user_id;

-- name: UserByCalendarFeed :one
SELECT u.* FROM calendar_feeds f JOIN users u ON u.id = f.user_id WHERE f.token_hash = @token_hash;

-- name: SetUserLanguage :exec
UPDATE users SET language = sqlc.narg(language) WHERE id = @id;

-- name: UserMeetings :many
-- A person's meetings for their data export.
SELECT m.id, m.title, m.starts_at, m.ends_at, m.timezone, m.rrule, m.cancelled_at, i.response,
    (m.organizer_id = @user_id)::boolean AS organizer
FROM meeting_invitees i JOIN meetings m ON m.id = i.meeting_id
WHERE i.user_id = @user_id
ORDER BY m.starts_at;

-- name: EraseUserMeetings :exec
-- Erasure: the person leaves every meeting and loses the subscription
-- address; meetings they planned stay for the others, without an organizer.
WITH left_meetings AS (DELETE FROM meeting_invitees WHERE user_id = @user_id),
     feeds AS (DELETE FROM calendar_feeds WHERE user_id = @user_id),
     mails AS (DELETE FROM meeting_mails WHERE user_id = @user_id)
UPDATE meetings SET organizer_id = NULL WHERE organizer_id = @user_id;

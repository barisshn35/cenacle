-- name: LastMessageAt :one
-- LastMessageAt is when a member last sent a message in a channel (slow mode).
SELECT created_at FROM messages
WHERE channel_id = @channel_id AND author_id = @author_id AND deleted_at IS NULL
ORDER BY id DESC LIMIT 1;

-- name: GetMemberTimeout :one
SELECT timeout_until FROM workspace_members WHERE workspace_id = @workspace_id AND user_id = @user_id;

-- name: SetMemberTimeout :execrows
UPDATE workspace_members SET timeout_until = sqlc.narg(until)
WHERE workspace_id = @workspace_id AND user_id = @user_id;

-- ---------------------------------------------------------------- AutoMod ---

-- name: ListAutomodRules :many
SELECT * FROM automod_rules WHERE workspace_id = @workspace_id ORDER BY created_at;

-- name: ListEnabledAutomodRules :many
SELECT * FROM automod_rules WHERE workspace_id = @workspace_id AND enabled ORDER BY created_at;

-- name: CountAutomodRules :one
SELECT count(*)::int FROM automod_rules WHERE workspace_id = @workspace_id;

-- name: GetAutomodRule :one
SELECT * FROM automod_rules WHERE id = @id;

-- name: CreateAutomodRule :one
INSERT INTO automod_rules (workspace_id, name, kind, config, action, exempt_roles, enabled)
VALUES (@workspace_id, @name, @kind, @config, @action, @exempt_roles::text[], @enabled)
RETURNING *;

-- name: UpdateAutomodRule :one
UPDATE automod_rules
SET name = @name, kind = @kind, config = @config, action = @action,
    exempt_roles = @exempt_roles::text[], enabled = @enabled
WHERE id = @id
RETURNING *;

-- name: DeleteAutomodRule :execrows
DELETE FROM automod_rules WHERE id = @id;

-- ---------------------------------------------------------------- reports ---

-- name: CreateReport :execrows
INSERT INTO message_reports (workspace_id, message_id, reporter_id, rule_name, reason)
VALUES (@workspace_id, @message_id, sqlc.narg(reporter_id), @rule_name, @reason)
ON CONFLICT DO NOTHING;

-- name: ListReports :many
-- ListReports returns the open (or the closed) reports of a workspace, newest
-- first, with how many open reports each message has.
SELECT r.*, ru.display_name AS reporter_name,
       (SELECT count(*) FROM message_reports o
        WHERE o.message_id = r.message_id AND o.status = 'open')::int AS open_reports
FROM message_reports r
LEFT JOIN users ru ON ru.id = r.reporter_id
WHERE r.workspace_id = @workspace_id
  AND (CASE WHEN @open::boolean THEN r.status = 'open' ELSE r.status <> 'open' END)
ORDER BY r.created_at DESC
LIMIT 200;

-- name: GetReport :one
SELECT * FROM message_reports WHERE id = @id;

-- name: ResolveReports :many
-- ResolveReports closes every open report of a message.
UPDATE message_reports
SET status = @status, action = @action, resolved_by = @resolved_by, resolved_at = now()
WHERE message_id = @message_id AND status = 'open'
RETURNING *;

-- ------------------------------------------------------------------ polls ---

-- name: CreatePoll :exec
INSERT INTO polls (message_id, multiple, anonymous, closes_at)
VALUES (@message_id, @multiple, @anonymous, sqlc.narg(closes_at));

-- name: AddPollOptions :exec
INSERT INTO poll_options (message_id, position, text)
SELECT @message_id, o.ordinality - 1, o.text
FROM unnest(@texts::text[]) WITH ORDINALITY AS o(text, ordinality);

-- name: GetPoll :one
SELECT * FROM polls WHERE message_id = @message_id;

-- name: ListPolls :many
SELECT * FROM polls WHERE message_id = ANY(@message_ids::uuid[]);

-- name: ListPollOptions :many
-- ListPollOptions returns the options of polls with their votes and whether
-- the reader chose them.
SELECT o.id, o.message_id, o.text,
       (SELECT count(*) FROM poll_votes v WHERE v.option_id = o.id)::int AS votes,
       EXISTS (SELECT 1 FROM poll_votes v WHERE v.option_id = o.id AND v.user_id = @reader_id) AS me
FROM poll_options o
WHERE o.message_id = ANY(@message_ids::uuid[])
ORDER BY o.message_id, o.position;

-- name: ListPollVoters :many
-- ListPollVoters returns who chose what in polls that are not anonymous.
SELECT v.option_id, v.message_id, u.id AS user_id, u.display_name, u.is_bot
FROM poll_votes v
JOIN polls p ON p.message_id = v.message_id AND NOT p.anonymous
JOIN users u ON u.id = v.user_id
WHERE v.message_id = ANY(@message_ids::uuid[])
ORDER BY v.created_at;

-- name: CountPollVoters :many
SELECT message_id, count(DISTINCT user_id)::int AS voters
FROM poll_votes WHERE message_id = ANY(@message_ids::uuid[])
GROUP BY message_id;

-- name: ClearPollVotes :exec
DELETE FROM poll_votes WHERE message_id = @message_id AND user_id = @user_id;

-- name: AddPollVotes :execrows
INSERT INTO poll_votes (option_id, message_id, user_id)
SELECT o.id, o.message_id, @user_id
FROM poll_options o
WHERE o.message_id = @message_id AND o.id = ANY(@option_ids::uuid[]);

-- name: ClosePoll :exec
UPDATE polls SET closed_at = coalesce(closed_at, now()) WHERE message_id = @message_id;

-- ----------------------------------------------------------------- events ---

-- name: CreateEvent :one
INSERT INTO events (workspace_id, channel_id, title, description, location, starts_at, ends_at, created_by)
VALUES (@workspace_id, sqlc.narg(channel_id), @title, @description, @location, @starts_at, @ends_at, @created_by)
RETURNING *;

-- name: UpdateEvent :one
UPDATE events
SET channel_id = sqlc.narg(channel_id), title = @title, description = @description, location = @location,
    starts_at = @starts_at, ends_at = @ends_at
WHERE id = @id AND canceled_at IS NULL
RETURNING *;

-- name: CancelEvent :execrows
UPDATE events SET canceled_at = now() WHERE id = @id AND canceled_at IS NULL;

-- name: GetEvent :one
SELECT * FROM events WHERE id = @id;

-- name: ListEvents :many
-- ListEvents returns a workspace's events that end after a moment, soonest first.
SELECT * FROM events
WHERE workspace_id = @workspace_id AND ends_at > @after AND canceled_at IS NULL
ORDER BY starts_at, id
LIMIT 100;

-- name: ListEventRsvps :many
SELECT r.event_id, r.user_id, r.status, u.display_name, u.is_bot
FROM event_rsvps r JOIN users u ON u.id = r.user_id
WHERE r.event_id = ANY(@event_ids::uuid[])
ORDER BY r.updated_at;

-- name: GetRsvp :one
SELECT * FROM event_rsvps WHERE event_id = @event_id AND user_id = @user_id;

-- name: SetRsvp :exec
INSERT INTO event_rsvps (event_id, user_id, status, reminder_id)
VALUES (@event_id, @user_id, @status, sqlc.narg(reminder_id))
ON CONFLICT (event_id, user_id) DO UPDATE
SET status = EXCLUDED.status, reminder_id = EXCLUDED.reminder_id, updated_at = now();

-- name: DeleteRsvp :exec
DELETE FROM event_rsvps WHERE event_id = @event_id AND user_id = @user_id;

-- name: ListEventReminders :many
SELECT user_id, reminder_id FROM event_rsvps WHERE event_id = @event_id AND reminder_id IS NOT NULL;

-- ---------------------------------------------------------------- welcome ---

-- name: SetWorkspaceWelcome :one
UPDATE workspaces SET welcome = @welcome WHERE id = @id RETURNING *;

-- name: SetOnboarded :execrows
UPDATE workspace_members SET onboarded_at = coalesce(onboarded_at, now())
WHERE workspace_id = @workspace_id AND user_id = @user_id;

-- ------------------------------------------------------- banner and terms ---

-- name: GetBanner :one
SELECT * FROM instance_banner;

-- name: SetBanner :one
INSERT INTO instance_banner (text, level, dismissible) VALUES (@text, @level, @dismissible)
ON CONFLICT (id) DO UPDATE SET text = EXCLUDED.text, level = EXCLUDED.level,
    dismissible = EXCLUDED.dismissible, updated_at = now()
RETURNING *;

-- name: DeleteBanner :exec
DELETE FROM instance_banner;

-- name: GetActiveTerms :one
SELECT * FROM terms_of_service WHERE withdrawn_at IS NULL ORDER BY id DESC LIMIT 1;

-- name: CreateTerms :one
INSERT INTO terms_of_service (text, created_by) VALUES (@text, @created_by) RETURNING *;

-- name: WithdrawTerms :exec
UPDATE terms_of_service SET withdrawn_at = now() WHERE withdrawn_at IS NULL;

-- name: AcceptTerms :exec
UPDATE users SET terms_accepted_id = @terms_id WHERE id = @user_id;

-- -------------------------------------------------------------- playbooks ---

-- name: ListPlaybooks :many
SELECT p.*,
       (SELECT count(*) FROM playbook_runs r WHERE r.playbook_id = p.id AND r.status = 'active')::int AS runs_active
FROM playbooks p
WHERE p.workspace_id = @workspace_id AND p.archived_at IS NULL
ORDER BY lower(p.name);

-- name: GetPlaybook :one
SELECT * FROM playbooks WHERE id = @id AND archived_at IS NULL;

-- name: CreatePlaybook :one
INSERT INTO playbooks (workspace_id, name, description, checklists, created_by)
VALUES (@workspace_id, @name, @description, @checklists, @created_by)
RETURNING *;

-- name: UpdatePlaybook :one
UPDATE playbooks SET name = @name, description = @description, checklists = @checklists, updated_at = now()
WHERE id = @id AND archived_at IS NULL
RETURNING *;

-- name: ArchivePlaybook :execrows
UPDATE playbooks SET archived_at = now() WHERE id = @id AND archived_at IS NULL;

-- name: CountActiveRuns :one
SELECT count(*)::int FROM playbook_runs WHERE playbook_id = @playbook_id AND status = 'active';

-- name: CreateRun :one
INSERT INTO playbook_runs (playbook_id, workspace_id, channel_id, name, owner_id, checklists)
VALUES (@playbook_id, @workspace_id, @channel_id, @name, @owner_id, @checklists)
RETURNING *;

-- name: GetRun :one
SELECT * FROM playbook_runs WHERE id = @id;

-- name: ListChannelRuns :many
SELECT * FROM playbook_runs WHERE channel_id = @channel_id ORDER BY created_at DESC LIMIT 50;

-- name: ListWorkspaceActiveRuns :many
SELECT r.* FROM playbook_runs r
JOIN channel_members m ON m.channel_id = r.channel_id AND m.user_id = @user_id
WHERE r.workspace_id = @workspace_id AND r.status = 'active'
ORDER BY r.created_at DESC LIMIT 100;

-- name: SetRunChecklists :one
UPDATE playbook_runs SET checklists = @checklists WHERE id = @id AND status = 'active' RETURNING *;

-- name: FinishRun :one
UPDATE playbook_runs SET status = 'finished', finished_at = now() WHERE id = @id AND status = 'active' RETURNING *;

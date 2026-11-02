-- name: ListForms :many
SELECT * FROM forms WHERE workspace_id = @workspace_id AND archived_at IS NULL ORDER BY lower(name);

-- name: GetForm :one
SELECT * FROM forms WHERE id = @id;

-- name: CreateForm :one
INSERT INTO forms (workspace_id, name, description, fields, created_by)
VALUES (@workspace_id, @name, @description, @fields, @created_by)
RETURNING *;

-- name: UpdateForm :one
UPDATE forms SET name = @name, description = @description, fields = @fields, updated_at = now()
WHERE id = @id AND archived_at IS NULL
RETURNING *;

-- name: ArchiveForm :exec
UPDATE forms SET archived_at = now() WHERE id = @id AND archived_at IS NULL;

-- name: CountForms :one
SELECT count(*)::int FROM forms WHERE workspace_id = @workspace_id AND archived_at IS NULL;

-- name: CreateSubmission :one
INSERT INTO form_submissions (form_id, workspace_id, user_id, form_name, answers)
VALUES (@form_id, @workspace_id, @user_id, @form_name, @answers)
RETURNING *;

-- name: ListSubmissionsByID :many
SELECT s.*, coalesce(u.display_name, '') AS user_name
FROM form_submissions s LEFT JOIN users u ON u.id = s.user_id
WHERE s.id = ANY(@ids::uuid[]);

-- name: ListFormSubmissions :many
SELECT s.*, coalesce(u.display_name, '') AS user_name
FROM form_submissions s LEFT JOIN users u ON u.id = s.user_id
WHERE s.form_id = @form_id
  AND (sqlc.narg(before)::uuid IS NULL OR s.id < sqlc.narg(before)::uuid)
ORDER BY s.id DESC LIMIT @row_limit;

-- name: ListWorkflows :many
SELECT * FROM workflows WHERE workspace_id = @workspace_id AND archived_at IS NULL ORDER BY lower(name);

-- name: GetWorkflow :one
SELECT * FROM workflows WHERE id = @id;

-- name: CountWorkflows :one
SELECT count(*)::int FROM workflows WHERE workspace_id = @workspace_id AND archived_at IS NULL;

-- name: CreateWorkflow :one
INSERT INTO workflows (workspace_id, name, description, enabled, trigger, trigger_kind, channel_id, steps,
                       next_run_at, webhook_hash, secret, created_by)
VALUES (@workspace_id, @name, @description, @enabled, @trigger, @trigger_kind, sqlc.narg(channel_id), @steps,
        sqlc.narg(next_run_at), sqlc.narg(webhook_hash), @secret, @created_by)
RETURNING *;

-- name: UpdateWorkflow :one
UPDATE workflows SET name = @name, description = @description, enabled = @enabled, trigger = @trigger,
    trigger_kind = @trigger_kind, channel_id = sqlc.narg(channel_id), steps = @steps,
    next_run_at = sqlc.narg(next_run_at), updated_at = now()
WHERE id = @id AND archived_at IS NULL
RETURNING *;

-- name: SetWorkflowWebhook :exec
UPDATE workflows SET webhook_hash = sqlc.narg(webhook_hash) WHERE id = @id;

-- name: ArchiveWorkflow :exec
UPDATE workflows SET archived_at = now(), webhook_hash = NULL WHERE id = @id AND archived_at IS NULL;

-- name: GetWorkflowByWebhook :one
SELECT * FROM workflows WHERE webhook_hash = @webhook_hash AND archived_at IS NULL;

-- name: ListTriggeredWorkflows :many
-- ListTriggeredWorkflows returns the enabled workflows of a kind that watch a channel.
SELECT * FROM workflows
WHERE trigger_kind = @trigger_kind AND channel_id = @channel_id AND archived_at IS NULL AND enabled;

-- name: ListManualWorkflows :many
-- ListManualWorkflows returns the workflows people can start in a channel.
SELECT * FROM workflows
WHERE workspace_id = @workspace_id AND trigger_kind = 'manual' AND archived_at IS NULL AND enabled
  AND (channel_id IS NULL OR channel_id = @channel_id)
ORDER BY lower(name);

-- name: ClaimDueSchedules :many
-- ClaimDueSchedules returns scheduled workflows that are due, locked for this
-- transaction (several servers never start the same one twice).
SELECT * FROM workflows
WHERE trigger_kind = 'schedule' AND archived_at IS NULL AND enabled AND next_run_at <= now()
ORDER BY next_run_at LIMIT @row_limit
FOR UPDATE SKIP LOCKED;

-- name: SetWorkflowNextRun :exec
UPDATE workflows SET next_run_at = @next_run_at WHERE id = @id;

-- name: CreateWorkflowRun :one
INSERT INTO workflow_runs (workflow_id, workspace_id, workflow_name, steps, vars, trigger_user_id, channel_id,
    trigger_message_id)
VALUES (@workflow_id, @workspace_id, @workflow_name, @steps, @vars, sqlc.narg(trigger_user_id), sqlc.narg(channel_id),
    sqlc.narg(trigger_message_id))
RETURNING *;

-- name: ForgetTriggerMessage :many
-- ForgetTriggerMessage takes a removed message's text out of the runs it
-- started (their variables) and of their tasks (titles rendered from them).
WITH runs AS (
    UPDATE workflow_runs r SET vars = r.vars - 'trigger.message'
    WHERE r.trigger_message_id = @message_id
    RETURNING r.id, r.workflow_name
), tasks AS (
    UPDATE workflow_tasks t SET title = runs.workflow_name FROM runs WHERE t.run_id = runs.id RETURNING 1
)
SELECT id FROM runs;

-- name: MessageLive :one
-- MessageLive: the message exists and is not deleted.
SELECT EXISTS (SELECT 1 FROM messages WHERE id = @id AND deleted_at IS NULL);

-- name: ClaimDueWorkflowRuns :many
SELECT * FROM workflow_runs
WHERE status = 'running' AND wake_at <= now()
ORDER BY wake_at LIMIT @row_limit
FOR UPDATE SKIP LOCKED;

-- name: GetWorkflowRunForUpdate :one
SELECT * FROM workflow_runs WHERE id = @id FOR UPDATE;

-- name: SaveWorkflowRun :exec
UPDATE workflow_runs SET step = @step, status = @status, vars = @vars, wake_at = @wake_at, error = @error,
    finished_at = CASE WHEN @status IN ('done', 'failed', 'cancelled') THEN now() ELSE NULL END
WHERE id = @id;

-- name: ListWorkflowRuns :many
SELECT r.*, coalesce(u.display_name, '') AS trigger_user_name
FROM workflow_runs r LEFT JOIN users u ON u.id = r.trigger_user_id
WHERE r.workflow_id = @workflow_id
ORDER BY r.id DESC LIMIT @row_limit;

-- name: CreateWorkflowTask :one
INSERT INTO workflow_tasks (run_id, workspace_id, kind, title, assignees, form_id)
VALUES (@run_id, @workspace_id, @kind, @title, @assignees, sqlc.narg(form_id))
RETURNING *;

-- name: GetWorkflowTaskForUpdate :one
SELECT * FROM workflow_tasks WHERE id = @id FOR UPDATE;

-- name: FinishWorkflowTask :one
UPDATE workflow_tasks SET status = @status, done_by = @done_by, done_at = now(), comment = @comment,
    submission_id = sqlc.narg(submission_id)
WHERE id = @id AND status = 'open'
RETURNING *;

-- name: CancelWorkflowRunTasks :exec
UPDATE workflow_tasks SET status = 'cancelled', done_at = now() WHERE run_id = @run_id AND status = 'open';

-- name: ListWorkflowTasksByID :many
SELECT t.*, coalesce(u.display_name, '') AS done_by_name, coalesce(f.name, '') AS form_name
FROM workflow_tasks t
LEFT JOIN users u ON u.id = t.done_by
LEFT JOIN forms f ON f.id = t.form_id
WHERE t.id = ANY(@ids::uuid[]);

-- name: ListOpenWorkflowTasks :many
-- ListOpenWorkflowTasks returns the open tasks of a person in a workspace, newest first.
SELECT t.*, coalesce(f.name, '') AS form_name
FROM workflow_tasks t LEFT JOIN forms f ON f.id = t.form_id
WHERE t.workspace_id = @workspace_id AND t.status = 'open' AND @user_id::uuid = ANY(t.assignees)
ORDER BY t.id DESC LIMIT 100;

-- name: ListTaskMessages :many
-- ListTaskMessages returns the messages that show a task's card.
SELECT id, channel_id FROM messages WHERE task_id = @task_id AND deleted_at IS NULL;

-- name: GetWorkspaceMemberName :one
-- GetWorkspaceMemberName returns the name of a member of a workspace.
SELECT u.display_name FROM workspace_members m JOIN users u ON u.id = m.user_id
WHERE m.workspace_id = @workspace_id AND m.user_id = @user_id AND u.deactivated_at IS NULL;

-- name: CountRecentWorkflowRuns :one
SELECT count(*)::int FROM workflow_runs WHERE workflow_id = @workflow_id AND created_at > now() - interval '1 hour';

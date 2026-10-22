-- +goose Up
-- Automation: forms, workflows (a trigger and steps), their runs, and the
-- tasks a run waits for (a form to fill in, an approval to give).

-- A form of a workspace: its fields, filled in from the composer or a workflow.
CREATE TABLE forms (
    id           uuid        PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    name         text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
    description  text        NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
    -- [{"id", "label", "kind", "required", "options", "help"}]
    fields       jsonb       NOT NULL DEFAULT '[]',
    created_by   uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    archived_at  timestamptz
);
CREATE INDEX forms_workspace_idx ON forms (workspace_id) WHERE archived_at IS NULL;

-- What someone filled in. The answers are kept as label/value pairs too, so a
-- submission still reads after its form changes.
CREATE TABLE form_submissions (
    id           uuid        PRIMARY KEY DEFAULT uuidv7(),
    form_id      uuid        REFERENCES forms (id) ON DELETE SET NULL,
    workspace_id uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    user_id      uuid        REFERENCES users (id) ON DELETE SET NULL,
    form_name    text        NOT NULL,
    -- [{"id", "label", "value"}]
    answers      jsonb       NOT NULL DEFAULT '[]',
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX form_submissions_form_idx ON form_submissions (form_id, created_at DESC);

-- A workflow: what starts it and what it does.
CREATE TABLE workflows (
    id            uuid        PRIMARY KEY DEFAULT uuidv7(),
    workspace_id  uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    name          text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
    description   text        NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
    enabled       boolean     NOT NULL DEFAULT true,
    -- {"kind": "manual" | "member_joined" | "reaction" | "keyword" | "schedule" | "webhook",
    --  "channel_id", "emoji", "keyword", "schedule": {"every", "weekday", "time", "time_zone"}}
    trigger       jsonb       NOT NULL,
    trigger_kind  text        NOT NULL CHECK (trigger_kind IN
                    ('manual', 'member_joined', 'reaction', 'keyword', 'schedule', 'webhook')),
    -- The channel the trigger watches (none: any channel, for manual workflows).
    channel_id    uuid        REFERENCES channels (id) ON DELETE SET NULL,
    -- [{"id", "kind", ...}] see internal/chat/workflows.go
    steps         jsonb       NOT NULL DEFAULT '[]',
    -- Scheduled workflows: when they start next.
    next_run_at   timestamptz,
    -- Webhook workflows: the hash of the secret address's token.
    webhook_hash  bytea       UNIQUE,
    -- Signs the workflow's outgoing requests.
    secret        text        NOT NULL,
    created_by    uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    archived_at   timestamptz
);
CREATE INDEX workflows_workspace_idx ON workflows (workspace_id) WHERE archived_at IS NULL;
CREATE INDEX workflows_trigger_idx ON workflows (trigger_kind, channel_id)
    WHERE archived_at IS NULL AND enabled;
CREATE INDEX workflows_due_idx ON workflows (next_run_at)
    WHERE trigger_kind = 'schedule' AND archived_at IS NULL AND enabled;

-- A run of a workflow. "running": a step is due now (or at wake_at);
-- "waiting": a task (form, approval) must be done first.
CREATE TABLE workflow_runs (
    id              uuid        PRIMARY KEY DEFAULT uuidv7(),
    workflow_id     uuid        REFERENCES workflows (id) ON DELETE SET NULL,
    workspace_id    uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    workflow_name   text        NOT NULL,
    -- The steps as they were when the run started.
    steps           jsonb       NOT NULL,
    step            integer     NOT NULL DEFAULT 0,
    status          text        NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running', 'waiting', 'done', 'failed', 'cancelled')),
    -- Variables the steps fill in and use ({{trigger.user}}, {{form.x}}, …).
    vars            jsonb       NOT NULL DEFAULT '{}',
    wake_at         timestamptz NOT NULL DEFAULT now(),
    trigger_user_id uuid        REFERENCES users (id) ON DELETE SET NULL,
    channel_id      uuid        REFERENCES channels (id) ON DELETE SET NULL,
    error           text        NOT NULL DEFAULT '',
    created_at      timestamptz NOT NULL DEFAULT now(),
    finished_at     timestamptz
);
CREATE INDEX workflow_runs_due_idx ON workflow_runs (wake_at) WHERE status = 'running';
CREATE INDEX workflow_runs_workflow_idx ON workflow_runs (workflow_id, created_at DESC);

-- What a waiting run needs from people: a form filled in by one person, or a
-- decision by one of the approvers.
CREATE TABLE workflow_tasks (
    id            uuid        PRIMARY KEY DEFAULT uuidv7(),
    run_id        uuid        NOT NULL REFERENCES workflow_runs (id) ON DELETE CASCADE,
    workspace_id  uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    kind          text        NOT NULL CHECK (kind IN ('form', 'approval')),
    title         text        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 4000),
    -- Who may do it: the form's person, or the approvers.
    assignees     uuid[]      NOT NULL,
    form_id       uuid        REFERENCES forms (id) ON DELETE SET NULL,
    status        text        NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'done', 'approved', 'rejected', 'cancelled')),
    done_by       uuid        REFERENCES users (id) ON DELETE SET NULL,
    done_at       timestamptz,
    comment       text        NOT NULL DEFAULT '' CHECK (char_length(comment) <= 1000),
    submission_id uuid        REFERENCES form_submissions (id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflow_tasks_run_idx ON workflow_tasks (run_id);
CREATE INDEX workflow_tasks_open_idx ON workflow_tasks USING gin (assignees) WHERE status = 'open';

-- Messages that carry a task card or a form submission.
ALTER TABLE messages
    ADD COLUMN task_id       uuid REFERENCES workflow_tasks (id) ON DELETE SET NULL,
    ADD COLUMN submission_id uuid REFERENCES form_submissions (id) ON DELETE SET NULL;
ALTER TABLE messages DROP CONSTRAINT messages_body_check;
ALTER TABLE messages ADD CONSTRAINT messages_body_check
    CHECK (char_length(body) <= 4000 AND (body <> '' OR attachments <> '[]'::jsonb OR has_files
           OR sticker_id IS NOT NULL OR task_id IS NOT NULL OR submission_id IS NOT NULL));

-- +goose Down
DELETE FROM messages WHERE body = '' AND (task_id IS NOT NULL OR submission_id IS NOT NULL)
    AND attachments = '[]'::jsonb AND NOT has_files AND sticker_id IS NULL;
ALTER TABLE messages DROP CONSTRAINT messages_body_check;
ALTER TABLE messages ADD CONSTRAINT messages_body_check
    CHECK (char_length(body) <= 4000 AND (body <> '' OR attachments <> '[]'::jsonb OR has_files
           OR sticker_id IS NOT NULL));
ALTER TABLE messages DROP COLUMN submission_id, DROP COLUMN task_id;
DROP TABLE workflow_tasks;
DROP TABLE workflow_runs;
DROP TABLE workflows;
DROP TABLE form_submissions;
DROP TABLE forms;

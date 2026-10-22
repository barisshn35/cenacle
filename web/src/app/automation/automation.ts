// SPDX-License-Identifier: AGPL-3.0-only
import { queryOptions } from '@tanstack/react-query';
import { apiFetch, type components } from '@cenacle/core/api';
import type { Message } from '../chat/data';

export type Form = components['schemas']['Form'];
export type FormField = components['schemas']['FormField'];
export type FormInput = components['schemas']['FormInput'];
export type FormValues = components['schemas']['FormValues'];
export type Submission = components['schemas']['Submission'];
export type Workflow = components['schemas']['Workflow'];
export type WorkflowInput = components['schemas']['WorkflowInput'];
export type WorkflowStep = components['schemas']['WorkflowStep'];
export type WorkflowTrigger = components['schemas']['WorkflowTrigger'];
export type WorkflowRun = components['schemas']['WorkflowRun'];
export type WorkflowShortcut = components['schemas']['WorkflowShortcut'];
export type Task = components['schemas']['Task'];

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// --- forms ---------------------------------------------------------------------

export const formsQuery = (workspaceId: string | undefined) =>
  queryOptions({
    queryKey: ['forms', workspaceId],
    queryFn: () =>
      apiFetch<{ forms: Form[] }>(`/api/workspaces/${workspaceId}/forms`).then((r) => r.forms),
    enabled: !!workspaceId,
  });

export const createForm = (workspaceId: string, input: FormInput) =>
  apiFetch<Form>(`/api/workspaces/${workspaceId}/forms`, json(input));
export const updateForm = (id: string, input: FormInput) =>
  apiFetch<Form>(`/api/forms/${id}`, json(input, 'PUT'));
export const archiveForm = (id: string) => apiFetch<void>(`/api/forms/${id}`, { method: 'DELETE' });
export const submitForm = (formId: string, channelId: string, values: FormValues) =>
  apiFetch<Message>(`/api/forms/${formId}/submissions`, json({ channel_id: channelId, values }));

// --- workflows -------------------------------------------------------------------

export const workflowsQuery = (workspaceId: string | undefined) =>
  queryOptions({
    queryKey: ['workflows', workspaceId],
    queryFn: () =>
      apiFetch<{ workflows: Workflow[] }>(`/api/workspaces/${workspaceId}/workflows`).then(
        (r) => r.workflows,
      ),
    enabled: !!workspaceId,
  });

export const createWorkflow = (workspaceId: string, input: WorkflowInput) =>
  apiFetch<Workflow>(`/api/workspaces/${workspaceId}/workflows`, json(input));
export const updateWorkflow = (id: string, input: WorkflowInput) =>
  apiFetch<Workflow>(`/api/workflows/${id}`, json(input, 'PUT'));
export const archiveWorkflow = (id: string) =>
  apiFetch<void>(`/api/workflows/${id}`, { method: 'DELETE' });
export const rotateWorkflowWebhook = (id: string) =>
  apiFetch<Workflow>(`/api/workflows/${id}/webhook`, { method: 'POST' });

export const runsQuery = (workflowId: string) =>
  queryOptions({
    queryKey: ['workflow-runs', workflowId],
    queryFn: () =>
      apiFetch<{ runs: WorkflowRun[] }>(`/api/workflows/${workflowId}/runs`).then((r) => r.runs),
  });

export const startWorkflow = (workflowId: string, channelId: string) =>
  apiFetch<{ run: WorkflowRun; task?: Task | null }>(
    `/api/workflows/${workflowId}/runs`,
    json({ channel_id: channelId }),
  );

export const shortcutsQuery = (channelId: string) =>
  queryOptions({
    queryKey: ['shortcuts', channelId],
    queryFn: () =>
      apiFetch<{ workflows: WorkflowShortcut[]; forms: Form[] }>(
        `/api/channels/${channelId}/shortcuts`,
      ),
    staleTime: 60_000,
  });

// --- tasks -------------------------------------------------------------------------

export const taskQuery = (id: string) =>
  queryOptions({
    queryKey: ['task', id],
    queryFn: () => apiFetch<Task>(`/api/tasks/${id}`),
  });

export const myTasksQuery = (workspaceId: string | undefined) =>
  queryOptions({
    queryKey: ['tasks', workspaceId],
    queryFn: () =>
      apiFetch<{ tasks: Task[] }>(`/api/workspaces/${workspaceId}/tasks`).then((r) => r.tasks),
    enabled: !!workspaceId,
  });

export const submitTask = (id: string, values: FormValues) =>
  apiFetch<Task>(`/api/tasks/${id}/submit`, json({ values }));
export const decideTask = (id: string, approve: boolean, comment: string) =>
  apiFetch<Task>(`/api/tasks/${id}/decide`, json({ approve, ...(comment ? { comment } : {}) }));

/** A field id from a label: lowercase letters, digits and _. */
export const fieldId = (label: string, taken: string[]) => {
  const base =
    label
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/ı/g, 'i')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 28) || 'field';
  let id = base;
  for (let i = 2; taken.includes(id); i++) id = `${base}_${i}`;
  return id;
};

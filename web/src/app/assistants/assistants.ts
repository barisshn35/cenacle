// SPDX-License-Identifier: AGPL-3.0-only
// Assistants over MCP (ADR 0056): personal tokens and the drafts assistants leave.
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { apiFetch, type components } from '@cenacle/core/api';

export type AssistantToken = components['schemas']['AssistantToken'];
export type AssistantDraft = components['schemas']['AssistantDraft'];

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const assistantsQuery = queryOptions({
  queryKey: ['assistants'],
  queryFn: () =>
    apiFetch<{ allowed: boolean; mcp_url: string; tokens: AssistantToken[] }>('/api/me/assistants'),
});

export const createAssistantToken = (
  name: string,
  scopes: ('read' | 'draft')[],
  days: 7 | 30 | 90,
) =>
  apiFetch<AssistantToken & { token: string }>('/api/me/assistants', json({ name, scopes, days }));

export const revokeAssistantToken = (id: string) =>
  apiFetch<void>(`/api/me/assistants/${id}`, { method: 'DELETE' });

export const assistantDraftsQuery = queryOptions({
  queryKey: ['assistant-drafts'],
  queryFn: () =>
    apiFetch<{ drafts: AssistantDraft[] }>('/api/me/assistant-drafts').then((r) => r.drafts),
  staleTime: Infinity,
});

export const dropAssistantDraft = (channelId: string) =>
  apiFetch<void>(`/api/me/assistant-drafts/${channelId}`, { method: 'DELETE' });

/** An assistant left a draft: read them again. */
export const assistantDraftsChanged = (client: QueryClient) =>
  client.invalidateQueries({ queryKey: assistantDraftsQuery.queryKey });

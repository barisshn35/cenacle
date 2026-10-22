// SPDX-License-Identifier: AGPL-3.0-only
import { apiFetch, type components } from '@cenacle/core/api';
import { useSession } from '../auth/session';
import { useActiveWorkspace } from '../chat/active-workspace';
import type { Workspace } from '../chat/workspaces';

export type AIAnswer = components['schemas']['AIAnswer'];
export type ComposeAction = 'improve' | 'shorter' | 'formal' | 'friendly' | 'translate';

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * Whether AI shows at all: the operator configured a model and the workspace
 * turned it on. Otherwise no AI element is rendered anywhere.
 */
export function useAI(): boolean {
  const { permissions } = useSession();
  const { workspace } = useActiveWorkspace();
  return !!permissions.ai && !!workspace?.ai_enabled;
}

/** Whether the operator configured a model (admins may turn AI on). */
export function useAIAvailable(): boolean {
  return !!useSession().permissions.ai;
}

export const setWorkspaceAI = (workspaceId: string, enabled: boolean) =>
  apiFetch<Workspace>(`/api/workspaces/${workspaceId}/ai`, json({ enabled }, 'PUT'));
export const summarize = (channelId: string, language: string, rootId?: string) =>
  apiFetch<AIAnswer>(
    `/api/channels/${channelId}/ai/summary`,
    json({ language, ...(rootId ? { root_id: rootId } : {}) }),
  );
export const compose = (
  workspaceId: string,
  text: string,
  action: ComposeAction,
  language?: string,
) =>
  apiFetch<AIAnswer>(
    `/api/workspaces/${workspaceId}/ai/compose`,
    json({ text, action, ...(language ? { language } : {}) }),
  );
export const ask = (workspaceId: string, question: string, language: string) =>
  apiFetch<AIAnswer>(`/api/workspaces/${workspaceId}/ai/ask`, json({ question, language }));

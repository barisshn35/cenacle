// SPDX-License-Identifier: AGPL-3.0-only
import { queryOptions, useQuery, type QueryClient } from '@tanstack/react-query';
import { create } from 'zustand';
import { ApiError, apiFetch, type components } from '@cenacle/core/api';
import { useSession } from '../auth/session';
import { useActiveWorkspace } from '../chat/active-workspace';
import type { Workspace } from '../chat/workspaces';

export type AIAnswer = components['schemas']['AIAnswer'];
export type AIConsent = components['schemas']['AIConsent'];
export type ComposeAction = 'improve' | 'shorter' | 'formal' | 'friendly' | 'translate';

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const aiConsentQuery = queryOptions({
  queryKey: ['ai-consent'],
  queryFn: () => apiFetch<AIConsent>('/api/me/ai'),
  staleTime: Infinity,
});

export const setAIConsent = (accepted: boolean) =>
  apiFetch<AIConsent>('/api/me/ai', json({ accepted }, 'PUT'));

/** The person's answer to the AI notice ("undecided" until it loads). */
export function useAIConsent(): AIConsent | undefined {
  const available = !!useSession().permissions.ai;
  return useQuery({ ...aiConsentQuery, enabled: available }).data;
}

/**
 * Whether AI shows at all: the operator configured a model, the workspace
 * turned it on and the person did not decline the AI notice. Otherwise no AI
 * element is rendered anywhere.
 */
export function useAI(): boolean {
  const { permissions } = useSession();
  const { workspace } = useActiveWorkspace();
  const consent = useAIConsent();
  return (
    !!permissions.ai && !!workspace?.ai_enabled && !!consent && consent.decision !== 'declined'
  );
}

/** The AI notice, asked before a request of someone who has not accepted it. */
export const useAINotice = create<{
  pending: (() => void) | null;
  ask: (then: () => void) => void;
  close: () => void;
}>()((set) => ({
  pending: null,
  ask: (then) => set({ pending: then }),
  close: () => set({ pending: null }),
}));

/**
 * Runs an AI request only after the person accepted the notice; otherwise
 * shows the notice first and runs it if they accept.
 */
export function useAIGate(): (run: () => void) => void {
  const consent = useAIConsent();
  return (run) => {
    if (consent?.decision === 'accepted') run();
    else useAINotice.getState().ask(run);
  };
}

/** After the server refused for want of consent (e.g. the model changed). */
export function consentLost(err: unknown, queryClient: QueryClient): boolean {
  if (!(err instanceof ApiError) || err.problem.code !== 'ai_consent') return false;
  void queryClient.invalidateQueries({ queryKey: aiConsentQuery.queryKey });
  return true;
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

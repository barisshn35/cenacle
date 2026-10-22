// SPDX-License-Identifier: Apache-2.0
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { apiFetch, type components } from '@cenacle/core/api';
import { patchMessage } from '../chat/data';

export type Poll = components['schemas']['Poll'];
export type NewPoll = components['schemas']['NewPoll'];
export type Report = components['schemas']['Report'];
export type AutomodRule = components['schemas']['AutomodRule'];
export type AutomodRuleInput = components['schemas']['AutomodRuleInput'];
export type CommunityEvent = components['schemas']['Event'];
export type EventInput = components['schemas']['EventInput'];
export type Welcome = components['schemas']['Welcome'];
export type Banner = components['schemas']['Banner'];
export type BannerInput = components['schemas']['BannerInput'];
export type Terms = components['schemas']['Terms'];
export type Playbook = components['schemas']['Playbook'];
export type PlaybookInput = components['schemas']['PlaybookInput'];
export type Run = components['schemas']['Run'];

const json = (body: unknown, method: string): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// --- polls -------------------------------------------------------------------

const pollUrl = (channelId: string, messageId: string) =>
  `/api/channels/${channelId}/messages/${messageId}/poll`;

export const votePoll = (channelId: string, messageId: string, optionIds: string[]) =>
  apiFetch<Poll>(`${pollUrl(channelId, messageId)}/votes`, json({ option_ids: optionIds }, 'PUT'));

export const closePoll = (channelId: string, messageId: string) =>
  apiFetch<Poll>(`${pollUrl(channelId, messageId)}/close`, { method: 'POST' });

/**
 * A poll changed. The poll comes as its voter sees it: others keep their own
 * choices (`me`).
 */
export function applyPoll(
  queryClient: QueryClient,
  ev: { channel_id: string; message_id: string; user_id: string; poll: Poll },
  selfId: string,
): void {
  patchMessage(queryClient, ev.channel_id, ev.message_id, (m) => {
    if (ev.user_id === selfId || !m.poll) return { ...m, poll: ev.poll };
    const mine = new Set(m.poll.options.filter((o) => o.me).map((o) => o.id));
    return {
      ...m,
      poll: { ...ev.poll, options: ev.poll.options.map((o) => ({ ...o, me: mine.has(o.id) })) },
    };
  });
}

// --- moderation --------------------------------------------------------------

export const reportMessage = (channelId: string, messageId: string, reason: string) =>
  apiFetch<void>(
    `/api/channels/${channelId}/messages/${messageId}/report`,
    json({ reason }, 'POST'),
  );

export const reportsQuery = (workspaceId: string, status: 'open' | 'closed') =>
  queryOptions({
    queryKey: ['reports', workspaceId, status],
    queryFn: () =>
      apiFetch<{ reports: Report[] }>(
        `/api/workspaces/${workspaceId}/reports?status=${status}`,
      ).then((r) => r.reports),
  });

export const resolveReport = (
  id: string,
  action: 'dismiss' | 'delete' | 'timeout',
  timeoutMinutes?: number,
) =>
  apiFetch<Report>(
    `/api/reports/${id}/resolve`,
    json({ action, ...(timeoutMinutes ? { timeout_minutes: timeoutMinutes } : {}) }, 'POST'),
  );

export const setMemberTimeout = (workspaceId: string, userId: string, until: string | null) =>
  apiFetch<void>(
    `/api/workspaces/${workspaceId}/members/${userId}/timeout`,
    json({ until }, 'PUT'),
  );

export const automodQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ['automod', workspaceId],
    queryFn: () =>
      apiFetch<{ rules: AutomodRule[] }>(`/api/workspaces/${workspaceId}/automod`).then(
        (r) => r.rules,
      ),
  });

export const createAutomodRule = (workspaceId: string, rule: AutomodRuleInput) =>
  apiFetch<AutomodRule>(`/api/workspaces/${workspaceId}/automod`, json(rule, 'POST'));
export const updateAutomodRule = (id: string, rule: AutomodRuleInput) =>
  apiFetch<AutomodRule>(`/api/automod/${id}`, json(rule, 'PUT'));
export const deleteAutomodRule = (id: string) =>
  apiFetch<void>(`/api/automod/${id}`, { method: 'DELETE' });

// --- events ------------------------------------------------------------------

export const eventsQuery = (workspaceId: string | undefined) =>
  queryOptions({
    queryKey: ['events', workspaceId],
    queryFn: () =>
      apiFetch<{ events: CommunityEvent[] }>(`/api/workspaces/${workspaceId}/events`).then(
        (r) => r.events,
      ),
    enabled: !!workspaceId,
  });

export const createEvent = (workspaceId: string, e: EventInput) =>
  apiFetch<CommunityEvent>(`/api/workspaces/${workspaceId}/events`, json(e, 'POST'));
export const updateEvent = (id: string, e: EventInput) =>
  apiFetch<CommunityEvent>(`/api/events/${id}`, json(e, 'PUT'));
export const cancelEvent = (id: string) =>
  apiFetch<void>(`/api/events/${id}`, { method: 'DELETE' });
export const rsvpEvent = (id: string, status: CommunityEvent['me']) =>
  apiFetch<CommunityEvent>(`/api/events/${id}/rsvp`, json({ status }, 'PUT'));

// --- welcome -----------------------------------------------------------------

export const welcomeQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ['welcome', workspaceId],
    queryFn: () => apiFetch<Welcome>(`/api/workspaces/${workspaceId}/welcome`),
  });
export const setWelcome = (workspaceId: string, w: Welcome) =>
  apiFetch<Welcome>(`/api/workspaces/${workspaceId}/welcome`, json(w, 'PUT'));
export const finishOnboarding = (workspaceId: string, channelIds: string[]) =>
  apiFetch<void>(
    `/api/workspaces/${workspaceId}/onboarded`,
    json({ join_channel_ids: channelIds }, 'POST'),
  );

// --- banner and terms --------------------------------------------------------

export const bannerQuery = queryOptions({
  queryKey: ['banner'],
  queryFn: () => apiFetch<{ banner: Banner | null }>('/api/banner').then((r) => r.banner),
  staleTime: 5 * 60_000,
});
export const setBanner = (b: BannerInput) => apiFetch<Banner>('/api/banner', json(b, 'PUT'));
export const removeBanner = () => apiFetch<void>('/api/banner', { method: 'DELETE' });

export const termsQuery = queryOptions({
  queryKey: ['terms'],
  queryFn: () => apiFetch<{ terms: Terms | null; accepted: boolean }>('/api/terms'),
  staleTime: 5 * 60_000,
});
export const setTerms = (text: string) => apiFetch<Terms>('/api/terms', json({ text }, 'PUT'));
export const withdrawTerms = () => apiFetch<void>('/api/terms', { method: 'DELETE' });
export const acceptTerms = (id: string) =>
  apiFetch<void>('/api/terms/accept', json({ terms_id: id }, 'POST'));

// --- playbooks ---------------------------------------------------------------

export const playbooksQuery = (workspaceId: string | undefined) =>
  queryOptions({
    queryKey: ['playbooks', workspaceId],
    queryFn: () =>
      apiFetch<{ playbooks: Playbook[] }>(`/api/workspaces/${workspaceId}/playbooks`).then(
        (r) => r.playbooks,
      ),
    enabled: !!workspaceId,
  });
export const createPlaybook = (workspaceId: string, p: PlaybookInput) =>
  apiFetch<Playbook>(`/api/workspaces/${workspaceId}/playbooks`, json(p, 'POST'));
export const updatePlaybook = (id: string, p: PlaybookInput) =>
  apiFetch<Playbook>(`/api/playbooks/${id}`, json(p, 'PUT'));
export const archivePlaybook = (id: string) =>
  apiFetch<void>(`/api/playbooks/${id}`, { method: 'DELETE' });

export const startRun = (playbookId: string, channelId: string, name: string) =>
  apiFetch<Run>(`/api/playbooks/${playbookId}/runs`, json({ channel_id: channelId, name }, 'POST'));
export const channelRunsQuery = (channelId: string) =>
  queryOptions({
    queryKey: ['runs', channelId],
    queryFn: () => apiFetch<{ runs: Run[] }>(`/api/channels/${channelId}/runs`).then((r) => r.runs),
  });
export const updateRunItem = (
  runId: string,
  change: {
    checklist: number;
    item: number;
    done?: boolean;
    skipped?: boolean;
    assignee_id?: string | null;
  },
) => apiFetch<Run>(`/api/runs/${runId}/items`, json(change, 'PATCH'));
export const finishRun = (runId: string) =>
  apiFetch<Run>(`/api/runs/${runId}/finish`, { method: 'POST' });

/** run.updated: the run replaces its old self in its channel's list. */
export function applyRun(queryClient: QueryClient, run: Run): void {
  queryClient.setQueryData<Run[]>(['runs', run.channel_id], (list) =>
    list
      ? list.some((r) => r.id === run.id)
        ? list.map((r) => (r.id === run.id ? run : r))
        : [run, ...list]
      : list,
  );
}

/** Sends a poll: the question is the message's text. */
export const sendPoll = (channelId: string, question: string, poll: NewPoll, nonce: string) =>
  apiFetch<import('../chat/data').Message>(
    `/api/channels/${channelId}/messages`,
    json({ body: question, nonce, poll }, 'POST'),
  );

/** An ISO time still ahead. */
export const isFuture = (iso: string | null | undefined) =>
  !!iso && new Date(iso).getTime() > Date.now();

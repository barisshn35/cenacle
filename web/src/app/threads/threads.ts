// SPDX-License-Identifier: Apache-2.0
import { infiniteQueryOptions, queryOptions, type QueryClient } from '@tanstack/react-query';
import { apiFetch, type components } from '@cenacle/core/api';
import { patchMessage, type Message } from '../chat/data';

export type ThreadSummary = components['schemas']['ThreadSummary'];
export type FollowedThread = components['schemas']['FollowedThread'];
export type SavedItem = components['schemas']['SavedItem'];
export type ActivityItem = components['schemas']['ActivityItem'];

const json = (body: unknown, method: string): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// --- threads -----------------------------------------------------------------

export const threadFollowQuery = (rootId: string) =>
  queryOptions({
    queryKey: ['thread-follow', rootId],
    queryFn: () =>
      apiFetch<{ following: boolean; last_read_id: string | null }>(`/api/me/threads/${rootId}`),
    staleTime: Infinity,
  });

export const setFollowing = (rootId: string, following: boolean) =>
  apiFetch<void>(`/api/me/threads/${rootId}`, json({ following }, 'PUT'));

export const markThreadRead = (rootId: string, messageId: string) =>
  apiFetch<void>(`/api/me/threads/${rootId}/read`, json({ message_id: messageId }, 'POST'));

export const followedThreadsQuery = (workspaceId: string | undefined) =>
  infiniteQueryOptions({
    queryKey: ['me', 'threads', workspaceId],
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams({ limit: '20' });
      if (workspaceId) q.set('workspace_id', workspaceId);
      if (pageParam) q.set('before', pageParam);
      return apiFetch<{ threads: FollowedThread[]; has_more: boolean }>(
        `/api/me/threads?${q.toString()}`,
      );
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => (page.has_more ? page.threads.at(-1)?.last_reply_id : undefined),
    enabled: !!workspaceId,
  });

export const unreadThreadsQuery = (workspaceId: string | undefined) =>
  queryOptions({
    queryKey: ['me', 'threads-unread', workspaceId],
    queryFn: () =>
      apiFetch<{ threads: number; mentions: number }>(
        `/api/me/threads/unread?workspace_id=${workspaceId}`,
      ),
    enabled: !!workspaceId,
    staleTime: 60_000,
  });

/** Followed threads changed (a reply, reading): their lists and counts refresh. */
export function threadsChanged(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ['me', 'threads'] });
  void queryClient.invalidateQueries({ queryKey: ['me', 'threads-unread'] });
  void queryClient.invalidateQueries({ queryKey: ['me', 'activity'] });
}

/** thread.updated: a thread's replies changed. */
export function applyThreadUpdated(
  queryClient: QueryClient,
  ev: { channel_id: string; root_id: string; thread: ThreadSummary | null },
): void {
  patchMessage(queryClient, ev.channel_id, ev.root_id, (m) => {
    const { thread: _, ...rest } = m;
    return ev.thread ? { ...rest, thread: ev.thread } : rest;
  });
}

// --- pins --------------------------------------------------------------------

export const pinsQuery = (channelId: string) =>
  queryOptions({
    queryKey: ['pins', channelId],
    queryFn: () =>
      apiFetch<{ messages: Message[] }>(`/api/channels/${channelId}/pins`).then((r) => r.messages),
  });

export const setPinned = (m: Pick<Message, 'id' | 'channel_id'>, pinned: boolean) =>
  apiFetch<Message>(`/api/channels/${m.channel_id}/messages/${m.id}/pin`, {
    method: pinned ? 'PUT' : 'DELETE',
  });

// --- saved -------------------------------------------------------------------

export const savedQuery = queryOptions({
  queryKey: ['me', 'saved'],
  queryFn: () => apiFetch<{ items: SavedItem[] }>('/api/me/saved').then((r) => r.items),
  staleTime: 5 * 60_000,
});

export const saveMessage = (
  messageId: string,
  state: { remind_at?: string | null; done?: boolean } = {},
) => apiFetch<SavedItem>(`/api/me/saved/${messageId}`, json(state, 'PUT'));

export const unsaveMessage = (messageId: string) =>
  apiFetch<void>(`/api/me/saved/${messageId}`, { method: 'DELETE' });

/** saved.changed (or a change made here): the item replaces or leaves the list. */
export function applySaved(
  queryClient: QueryClient,
  messageId: string,
  item: SavedItem | null,
): void {
  queryClient.setQueryData<SavedItem[]>(savedQuery.queryKey, (list) => {
    if (!list) return list;
    const rest = list.filter((s) => s.message.id !== messageId);
    return item ? [item, ...rest].sort((a, b) => b.saved_at.localeCompare(a.saved_at)) : rest;
  });
}

// --- activity and unreads ----------------------------------------------------

export const activityQuery = (workspaceId: string | undefined) =>
  infiniteQueryOptions({
    queryKey: ['me', 'activity', workspaceId],
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams({ limit: '30' });
      if (workspaceId) q.set('workspace_id', workspaceId);
      if (pageParam) q.set('before', pageParam);
      return apiFetch<{ items: ActivityItem[]; has_more: boolean }>(
        `/api/me/activity?${q.toString()}`,
      );
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => (page.has_more ? page.items.at(-1)?.at : undefined),
    enabled: !!workspaceId,
  });

export const unreadsQuery = (workspaceId: string | undefined) =>
  queryOptions({
    queryKey: ['me', 'unreads', workspaceId],
    queryFn: () =>
      apiFetch<{ channels: { channel_id: string; messages: Message[] }[] }>(
        `/api/me/unreads?workspace_id=${workspaceId}`,
      ).then((r) => r.channels),
    enabled: !!workspaceId,
  });

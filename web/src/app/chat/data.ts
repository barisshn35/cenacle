// SPDX-License-Identifier: Apache-2.0
import {
  infiniteQueryOptions,
  queryOptions,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import { apiFetch, type components } from '@cenacle/core/api';

export type Channel = components['schemas']['Channel'];
export type Message = components['schemas']['Message'];
export type MessagePage = components['schemas']['MessagePage'];

export type NewChannel = components['schemas']['NewChannel'];

/** Channels the user is a member of (the sidebar). */
export const channelsQuery = queryOptions({
  queryKey: ['channels'],
  queryFn: () => apiFetch<{ channels: Channel[] }>('/api/channels').then((r) => r.channels),
  staleTime: 5 * 60_000,
});

/** Every channel, with membership (browsing). */
export const directoryQuery = queryOptions({
  queryKey: ['channels', 'directory'],
  queryFn: () =>
    apiFetch<{ channels: Channel[] }>('/api/channels/directory').then((r) => r.channels),
});

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const createChannel = (input: NewChannel) => apiFetch<Channel>('/api/channels', json(input));
export const joinChannel = (id: string) =>
  apiFetch<Channel>(`/api/channels/${id}/join`, { method: 'POST' });
export const leaveChannel = (id: string) =>
  apiFetch<void>(`/api/channels/${id}/leave`, { method: 'POST' });

/** Channel lists changed (created, joined, left): reload them. */
export function reloadChannels(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: ['channels'] });
}

const PAGE = 50;

/**
 * Messages of a channel. Page 0 is the newest; "next" pages are older. Live
 * events keep the cache current, so it does not go stale on its own; a resync
 * invalidates it.
 */
export const messagesQuery = (channelId: string) =>
  infiniteQueryOptions({
    queryKey: ['messages', channelId],
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams({ limit: String(PAGE) });
      if (pageParam) q.set('before', pageParam);
      return apiFetch<MessagePage>(`/api/channels/${channelId}/messages?${q.toString()}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => (page.has_more ? page.messages[0]?.id : undefined),
    staleTime: Infinity,
  });

/** All loaded messages of a channel, oldest first, each once. */
export function flatten(data: InfiniteData<MessagePage> | undefined): Message[] {
  if (!data) return [];
  const seen = new Set<string>();
  return data.pages
    .toReversed()
    .flatMap((p) => p.messages)
    .filter((m) => !seen.has(m.id) && seen.add(m.id));
}

/**
 * Reloads all message lists after events may have been missed. Older pages
 * are dropped first: refetched with their old cursors they would overlap the
 * new newest page. The list keeps showing while it reloads.
 */
export function reloadMessages(queryClient: QueryClient): Promise<void> {
  queryClient.setQueriesData<InfiniteData<MessagePage, string | undefined>>(
    { queryKey: ['messages'] },
    (data) => data && { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) },
  );
  return queryClient.invalidateQueries({ queryKey: ['messages'] });
}

/** Adds a message to the newest page unless it is there already. */
export function addMessage(queryClient: QueryClient, message: Message): void {
  queryClient.setQueryData<InfiniteData<MessagePage, string | undefined>>(
    ['messages', message.channel_id],
    (data) => {
      if (!data) return data; // not loaded: it will come with the first fetch
      if (data.pages.some((p) => p.messages.some((m) => m.id === message.id))) return data;
      const [newest, ...older] = data.pages;
      const messages = [...(newest?.messages ?? []), message].sort((a, b) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      );
      return {
        ...data,
        pages: [{ has_more: newest?.has_more ?? false, messages }, ...older],
      };
    },
  );
}

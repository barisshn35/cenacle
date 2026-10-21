// SPDX-License-Identifier: Apache-2.0
import {
  infiniteQueryOptions,
  queryOptions,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import i18next from 'i18next';
import { apiFetch, type components } from '@cenacle/core/api';

export type Channel = components['schemas']['Channel'];
export type Message = components['schemas']['Message'];
export type MessagePage = components['schemas']['MessagePage'];

export type NewChannel = components['schemas']['NewChannel'];
export type ChannelUpdate = components['schemas']['ChannelUpdate'];
export type Member = components['schemas']['Member'];
export type Person = components['schemas']['Person'];
export type Category = components['schemas']['Category'];

export type PresenceStatus = 'online' | 'away' | 'dnd' | 'offline';

/** Direct and group conversations, as opposed to channels. */
export const isConversation = (c: Pick<Channel, 'kind'>) =>
  c.kind === 'direct' || c.kind === 'group';

/**
 * A conversation is named after its other people (the server's name is a
 * key), so every view can show `name`.
 */
function displayName(c: Channel): Channel {
  if (!isConversation(c)) return c;
  const names = c.participants.map((p) => p.display_name || p.email);
  return { ...c, name: names.length ? names.join(', ') : i18next.t('dm.onlyYou') };
}

/** Channels the user is a member of (the sidebar). */
export const channelsQuery = queryOptions({
  queryKey: ['channels'],
  queryFn: () =>
    apiFetch<{ channels: Channel[] }>('/api/channels').then((r) => r.channels.map(displayName)),
  staleTime: 5 * 60_000,
});

/** Opens (or finds) the conversation with these people. */
export const openConversation = (workspaceId: string, userIds: string[]) =>
  apiFetch<Channel>(
    `/api/workspaces/${workspaceId}/conversations`,
    json({ user_ids: userIds }),
  ).then(displayName);

export const markRead = (channelId: string, messageId: string) =>
  apiFetch<void>(`/api/channels/${channelId}/read`, json({ message_id: messageId }));
export const sendTyping = (channelId: string) =>
  apiFetch<void>(`/api/channels/${channelId}/typing`, { method: 'POST' });
export const setPresence = (status: Exclude<PresenceStatus, 'offline'>) =>
  apiFetch<void>('/api/presence', { ...json({ status }), method: 'PUT' });
export const presenceQuery = (workspaceId: string | undefined) =>
  queryOptions({
    queryKey: ['presence', workspaceId],
    queryFn: () =>
      apiFetch<{ presence: components['schemas']['Presence'][] }>(
        `/api/workspaces/${workspaceId}/presence`,
      ).then((r) => r.presence),
    enabled: !!workspaceId,
    staleTime: Infinity,
  });

/** Changes the user's channel entry in the cache. */
function patchChannel(
  queryClient: QueryClient,
  channelId: string,
  patch: (c: Channel) => Channel,
): void {
  queryClient.setQueryData<Channel[]>(['channels'], (list) =>
    list?.map((c) => (c.id === channelId ? patch(c) : c)),
  );
}

/** The channel is read up to a message (here or on another device). */
export function setReadLocally(queryClient: QueryClient, channelId: string, messageId: string) {
  patchChannel(queryClient, channelId, (c) =>
    c.last_read_id && c.last_read_id >= messageId
      ? c
      : { ...c, last_read_id: messageId, unread_count: 0, mention_count: 0 },
  );
}

/** A message arrived: someone else's counts as unread (up to 100). */
export function countIncoming(queryClient: QueryClient, message: Message, selfId: string) {
  if (message.author.id === selfId) {
    setReadLocally(queryClient, message.channel_id, message.id);
    return;
  }
  patchChannel(queryClient, message.channel_id, (c) =>
    c.last_read_id && c.last_read_id >= message.id
      ? c
      : {
          ...c,
          unread_count: Math.min(c.unread_count + 1, 100),
          mention_count: message.mentions.some((p) => p.id === selfId)
            ? Math.min(c.mention_count + 1, 100)
            : c.mention_count,
        },
  );
}

/** The channels of a workspace the user can see, with membership (browsing). */
export const directoryQuery = (workspaceId: string | undefined) =>
  queryOptions({
    queryKey: ['channels', 'directory', workspaceId],
    queryFn: () =>
      apiFetch<{ channels: Channel[] }>(`/api/channels/directory?workspace_id=${workspaceId}`).then(
        (r) => r.channels,
      ),
    enabled: !!workspaceId,
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
export const updateChannel = (id: string, update: ChannelUpdate) =>
  apiFetch<Channel>(`/api/channels/${id}`, { ...json(update), method: 'PATCH' });
export const addMember = (channelId: string, userId: string) =>
  apiFetch<Member>(`/api/channels/${channelId}/members`, json({ user_id: userId }));
export const removeMember = (channelId: string, userId: string) =>
  apiFetch<void>(`/api/channels/${channelId}/members/${userId}`, { method: 'DELETE' });

export const archiveChannel = (id: string) =>
  apiFetch<Channel>(`/api/channels/${id}/archive`, { method: 'POST' });
export const unarchiveChannel = (id: string) =>
  apiFetch<Channel>(`/api/channels/${id}/unarchive`, { method: 'POST' });
export const setChannelCategory = (id: string, categoryId: string | null) =>
  apiFetch<Channel>(`/api/channels/${id}/category`, {
    ...json({ category_id: categoryId }),
    method: 'PUT',
  });

export const categoriesQuery = (workspaceId: string | undefined) =>
  queryOptions({
    queryKey: ['categories', workspaceId],
    queryFn: () =>
      apiFetch<{ categories: Category[] }>(`/api/categories?workspace_id=${workspaceId}`).then(
        (r) => r.categories,
      ),
    staleTime: 5 * 60_000,
    enabled: !!workspaceId,
  });
export const createCategory = (workspaceId: string, name: string) =>
  apiFetch<Category>('/api/categories', json({ workspace_id: workspaceId, name }));
export const updateCategory = (id: string, update: { name?: string; position?: number }) =>
  apiFetch<Category>(`/api/categories/${id}`, { ...json(update), method: 'PATCH' });
export const deleteCategory = (id: string) =>
  apiFetch<void>(`/api/categories/${id}`, { method: 'DELETE' });

const messageUrl = (m: Pick<Message, 'id' | 'channel_id'>) =>
  `/api/channels/${m.channel_id}/messages/${m.id}`;
export const editMessage = (m: Message, body: string) =>
  apiFetch<Message>(messageUrl(m), { ...json({ body }), method: 'PATCH' });
export const deleteMessage = (m: Message) => apiFetch<void>(messageUrl(m), { method: 'DELETE' });
export const restoreMessage = (m: Message) =>
  apiFetch<Message>(`${messageUrl(m)}/restore`, { method: 'POST' });

export const membersQuery = (channelId: string) =>
  queryOptions({
    queryKey: ['members', channelId],
    queryFn: () =>
      apiFetch<{ members: Member[] }>(`/api/channels/${channelId}/members`).then((r) => r.members),
  });

export const peopleQuery = (workspaceId: string, q: string) =>
  queryOptions({
    queryKey: ['people', workspaceId, q],
    queryFn: () =>
      apiFetch<{ users: Person[] }>(
        `/api/users?workspace_id=${workspaceId}&q=${encodeURIComponent(q)}&limit=20`,
      ).then((r) => r.users),
    enabled: q.trim() !== '',
    staleTime: 30_000,
  });

export const setChannelMemberRole = (channelId: string, userId: string, role: Member['role']) =>
  apiFetch<Member>(`/api/channels/${channelId}/members/${userId}`, {
    ...json({ role }),
    method: 'PATCH',
  });

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

type MessageCache = InfiniteData<MessagePage, string | undefined>;

/** Queries that refetch once the fetch on its way has settled. */
const refetchAfter = new WeakSet<object>();

/**
 * A fetch of the channel's messages that is still on its way may have read
 * the channel before an event: fetch again once it settles, so the event is
 * not lost. (A first fetch cannot be restarted: TanStack Query joins it.)
 */
function refetchIfInFlight(queryClient: QueryClient, channelId: string): void {
  const query = queryClient
    .getQueryCache()
    .find({ queryKey: ['messages', channelId], exact: true });
  if (!query || query.state.fetchStatus !== 'fetching' || refetchAfter.has(query)) return;
  refetchAfter.add(query);
  void Promise.allSettled([query.promise]).then(() => {
    refetchAfter.delete(query);
    return queryClient.refetchQueries({ queryKey: ['messages', channelId], exact: true });
  });
}

/** Changes one loaded message. */
function patchMessage(
  queryClient: QueryClient,
  channelId: string,
  id: string,
  patch: (m: Message) => Message,
): void {
  refetchIfInFlight(queryClient, channelId);
  queryClient.setQueryData<MessageCache>(['messages', channelId], (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((p) => ({
            ...p,
            messages: p.messages.map((m) => (m.id === id ? patch(m) : m)),
          })),
        }
      : data,
  );
}

/**
 * Replaces a message (after an edit) wherever it is loaded. Edits do not
 * change reactions, and the event's reactions are the editor's view: the
 * reader's are kept.
 */
export function replaceMessage(queryClient: QueryClient, message: Message): void {
  patchMessage(queryClient, message.channel_id, message.id, (m) => ({
    ...message,
    reactions: m.reactions,
  }));
}

export interface ReactionEvent {
  channel_id: string;
  message_id: string;
  emoji: string;
  user_id: string;
}

/** A reaction was added or taken back (by anyone, the reader included). */
export function applyReaction(
  queryClient: QueryClient,
  ev: ReactionEvent,
  added: boolean,
  selfId: string,
): void {
  const mine = ev.user_id === selfId;
  patchMessage(queryClient, ev.channel_id, ev.message_id, (m) => {
    const existing = m.reactions.find((r) => r.emoji === ev.emoji);
    if (added) {
      if (existing?.me && mine) return m; // already counted (own optimistic update)
      const reactions = existing
        ? m.reactions.map((r) =>
            r.emoji === ev.emoji ? { ...r, count: r.count + 1, me: r.me || mine } : r,
          )
        : [...m.reactions, { emoji: ev.emoji, count: 1, me: mine }];
      return { ...m, reactions };
    }
    if (!existing || (mine && !existing.me)) return m;
    const reactions = m.reactions
      .map((r) =>
        r.emoji === ev.emoji ? { ...r, count: r.count - 1, me: mine ? false : r.me } : r,
      )
      .filter((r) => r.count > 0);
    return { ...m, reactions };
  });
}

export const addReaction = (m: Pick<Message, 'id' | 'channel_id'>, emoji: string) =>
  apiFetch<void>(`${messageUrl(m)}/reactions/${encodeURIComponent(emoji)}`, { method: 'PUT' });
export const removeReaction = (m: Pick<Message, 'id' | 'channel_id'>, emoji: string) =>
  apiFetch<void>(`${messageUrl(m)}/reactions/${encodeURIComponent(emoji)}`, { method: 'DELETE' });

/** Removes a message (deleted) from the cache. */
export function removeMessage(
  queryClient: QueryClient,
  ref: Pick<Message, 'id' | 'channel_id'>,
): void {
  refetchIfInFlight(queryClient, ref.channel_id);
  queryClient.setQueryData<MessageCache>(['messages', ref.channel_id], (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((p) => ({
            ...p,
            messages: p.messages.filter((m) => m.id !== ref.id),
          })),
        }
      : data,
  );
}

/** Adds a message to the newest page unless it is there already. */
export function addMessage(queryClient: QueryClient, message: Message): void {
  refetchIfInFlight(queryClient, message.channel_id);
  queryClient.setQueryData<InfiniteData<MessagePage, string | undefined>>(
    ['messages', message.channel_id],
    (data) => {
      if (!data) return data; // not loaded: it comes with the (restarted) first fetch
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

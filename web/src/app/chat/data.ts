// SPDX-License-Identifier: AGPL-3.0-only
import { sealFor } from '../compliance/e2e';
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

/** Marks a channel read up to a message (without one: all of it). */
export const markRead = (channelId: string, messageId?: string) =>
  apiFetch<void>(
    `/api/channels/${channelId}/read`,
    json(messageId ? { message_id: messageId } : {}),
  );
export interface ConversationReads {
  enabled: boolean;
  reads: { user_id: string; last_read_id: string | null }[];
}
/** How far the others in a conversation read (read receipts, where turned on). */
export const readsQuery = (channelId: string, enabled: boolean) =>
  queryOptions({
    queryKey: ['reads', channelId],
    queryFn: () => apiFetch<ConversationReads>(`/api/channels/${channelId}/reads`),
    enabled,
    staleTime: Infinity,
  });
/** Someone in a conversation read further (conversation.read). */
export function applyConversationRead(
  queryClient: QueryClient,
  ev: { channel_id: string; user_id: string; message_id: string },
) {
  queryClient.setQueryData<ConversationReads>(['reads', ev.channel_id], (d) => {
    if (!d) return d;
    const others = d.reads.filter((r) => r.user_id !== ev.user_id);
    const before = d.reads.find((r) => r.user_id === ev.user_id)?.last_read_id;
    const last = before && before > ev.message_id ? before : ev.message_id;
    return { ...d, reads: [...others, { user_id: ev.user_id, last_read_id: last }] };
  });
}

/** Marks a channel unread from a message (without one: its newest message). */
export const markUnread = (channelId: string, messageId?: string) =>
  apiFetch<void>(
    `/api/channels/${channelId}/unread`,
    json(messageId ? { message_id: messageId } : {}),
  );
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
  // A reload on its way may predate the change (as for messages below).
  refetchKeyIfInFlight(queryClient, ['channels']);
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

/** All of the channel is read (its newest message is not known here). */
export function clearCountsLocally(queryClient: QueryClient, channelId: string) {
  patchChannel(queryClient, channelId, (c) => ({ ...c, unread_count: 0, mention_count: 0 }));
}

/**
 * The channel was marked unread (here or on another device): the read position
 * moves back, and the counts come again from the server.
 */
export function setUnreadLocally(
  queryClient: QueryClient,
  channelId: string,
  lastReadId: string | null,
) {
  patchChannel(queryClient, channelId, (c) => ({ ...c, last_read_id: lastReadId }));
  void queryClient.invalidateQueries({ queryKey: ['channels'] });
}

/** The message shows in its channel's timeline (not a reply kept in its thread). */
export const inChannel = (m: Pick<Message, 'root_id' | 'also_in_channel'>) =>
  !m.root_id || !!m.also_in_channel;

/** A message arrived: someone else's counts as unread (up to 100). */
export function countIncoming(queryClient: QueryClient, message: Message, selfId: string) {
  // Replies kept in their thread count in the thread (followed threads).
  if (!inChannel(message)) return;
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
export const editMessage = async (m: Message, body: string) =>
  apiFetch<Message>(messageUrl(m), {
    ...json({ body: await sealFor(m.channel_id, body) }),
    method: 'PATCH',
  });
/** Puts an earlier version back, as it was kept (sealed in encrypted channels). */
export const restoreVersion = (m: Message, body: string) =>
  apiFetch<Message>(messageUrl(m), { ...json({ body }), method: 'PATCH' });
export type MessageEdit = components['schemas']['MessageEdit'];
export const messageEditsQuery = (m: Pick<Message, 'id' | 'channel_id' | 'edited_at'>) =>
  queryOptions({
    queryKey: ['message-edits', m.channel_id, m.id, m.edited_at],
    queryFn: () =>
      apiFetch<{ edits: MessageEdit[] }>(
        `/api/channels/${m.channel_id}/messages/${m.id}/edits`,
      ).then((r) => r.edits),
  });
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
  refetchKeyIfInFlight(queryClient, ['messages', channelId]);
}

function refetchKeyIfInFlight(queryClient: QueryClient, queryKey: readonly unknown[]): void {
  const query = queryClient.getQueryCache().find({ queryKey, exact: true });
  if (!query || query.state.fetchStatus !== 'fetching' || refetchAfter.has(query)) return;
  refetchAfter.add(query);
  void Promise.allSettled([query.promise]).then(() => {
    refetchAfter.delete(query);
    return queryClient.refetchQueries({ queryKey, exact: true });
  });
}

/** Changes one loaded message, in its channel, in threads and on its own. */
export function patchMessage(
  queryClient: QueryClient,
  channelId: string,
  id: string,
  patch: (m: Message) => Message,
): void {
  refetchIfInFlight(queryClient, channelId);
  const pages = (data: MessageCache | undefined) =>
    data
      ? {
          ...data,
          pages: data.pages.map((p) => ({
            ...p,
            messages: p.messages.map((m) => (m.id === id ? patch(m) : m)),
          })),
        }
      : data;
  queryClient.setQueryData<MessageCache>(['messages', channelId], pages);
  queryClient.setQueriesData<MessageCache>({ queryKey: ['replies'] }, pages);
  queryClient.setQueryData<Message>(['message', id], (m) => m && patch(m));
}

/**
 * The replies of a thread. Page 0 is the newest; "next" pages are older. Live
 * events keep it current.
 */
export const repliesQuery = (channelId: string, rootId: string) =>
  // The root is unique across channels: the key leaves the channel out.
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  infiniteQueryOptions({
    queryKey: ['replies', rootId],
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams({ limit: String(PAGE) });
      if (pageParam) q.set('before', pageParam);
      return apiFetch<MessagePage>(
        `/api/channels/${channelId}/messages/${rootId}/replies?${q.toString()}`,
      );
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => (page.has_more ? page.messages[0]?.id : undefined),
    staleTime: Infinity,
  });

/** One message (a thread's first message), from a loaded list when there. */
export const messageQuery = (queryClient: QueryClient, channelId: string, id: string) =>
  // Message ids are unique across channels: the key leaves the channel out.
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  queryOptions({
    queryKey: ['message', id],
    queryFn: () => apiFetch<Message>(`/api/channels/${channelId}/messages/${id}`),
    initialData: () =>
      flatten(queryClient.getQueryData<MessageCache>(['messages', channelId])).find(
        (m) => m.id === id,
      ),
    staleTime: Infinity,
  });

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

/** Someone acknowledged a message, or took it back (here or elsewhere). */
export function applyAck(
  queryClient: QueryClient,
  ev: {
    channel_id: string;
    message_id: string;
    user_id: string;
    display_name: string;
    acked: boolean;
  },
  selfId: string,
): void {
  patchMessage(queryClient, ev.channel_id, ev.message_id, (m) => {
    if (!m.ack) return m;
    const has = m.ack.people.some((p) => p.id === ev.user_id);
    if (ev.acked === has) return m;
    const people = ev.acked
      ? [...m.ack.people, { id: ev.user_id, display_name: ev.display_name }]
      : m.ack.people.filter((p) => p.id !== ev.user_id);
    return {
      ...m,
      ack: {
        count: Math.max(m.ack.count + (ev.acked ? 1 : -1), 0),
        me: ev.user_id === selfId ? ev.acked : m.ack.me,
        people,
      },
    };
  });
}
export const ackMessage = (m: Pick<Message, 'id' | 'channel_id'>, acked: boolean) =>
  apiFetch<void>(`${messageUrl(m)}/ack`, { method: acked ? 'PUT' : 'DELETE' });

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
  const without = (data: MessageCache | undefined) =>
    data
      ? {
          ...data,
          pages: data.pages.map((p) => ({
            ...p,
            messages: p.messages.filter((m) => m.id !== ref.id),
          })),
        }
      : data;
  queryClient.setQueryData<MessageCache>(['messages', ref.channel_id], without);
  queryClient.setQueriesData<MessageCache>({ queryKey: ['replies'] }, without);
}

/**
 * Adds a message to the newest page of its channel (and of its thread, for a
 * reply) unless it is there already.
 */
export function addMessage(queryClient: QueryClient, message: Message): void {
  if (message.root_id) addToList(queryClient, ['replies', message.root_id], message);
  if (inChannel(message)) addToList(queryClient, ['messages', message.channel_id], message);
}

function addToList(queryClient: QueryClient, queryKey: readonly unknown[], message: Message) {
  refetchKeyIfInFlight(queryClient, queryKey);
  queryClient.setQueryData<InfiniteData<MessagePage, string | undefined>>(queryKey, (data) => {
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
  });
}

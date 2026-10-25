// SPDX-License-Identifier: AGPL-3.0-only
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import { groupsQuery, mentionable, mentionsMyGroup, type GroupList } from '../groups/groups';
import { myProfileQuery, type MyProfile } from '../profile/profiles';
import { inChannel, type Channel, type Message } from '../chat/data';
import type { FollowedThread } from '../threads/threads';
import {
  kindOf,
  notificationsQuery,
  notifies,
  soundFor,
  type NotificationSettings,
} from './notifications';
import { playSound } from './sounds';
import { metaQuery, type Meta } from '../auth/web-app';
import i18next from 'i18next';
import { toast } from 'sonner';
import { plainOf } from '../compliance/e2e';
import { useLayout } from '../../stores/layout';

/** The channel in view, from the address (/c/<id>). */
function viewedChannel(): string | undefined {
  return /^\/c\/([0-9a-f-]{36})/.exec(window.location.pathname)?.[1];
}

export function excerpt(body: string, n = 140): string {
  // An encrypted message this page has not opened shows as a lock.
  const text = (plainOf(body) ?? '🔒')
    .replace(/<@[0-9a-f-]{36}>/g, '@…')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > n ? `${text.slice(0, n)}…` : text;
}

/** Whether the person follows a thread, as far as this page knows. */
function follows(queryClient: QueryClient, rootId: string): boolean {
  const own = queryClient.getQueryData<{ following: boolean }>(['thread-follow', rootId]);
  if (own) return own.following;
  return queryClient
    .getQueriesData<InfiniteData<{ threads: FollowedThread[] }>>({ queryKey: ['me', 'threads'] })
    .some(([, data]) => data?.pages.some((p) => p.threads.some((t) => t.root.id === rootId)));
}

/**
 * What a desktop notification may show under the server's notification
 * policy: everything, the sender and channel only, or only that something came.
 */
function byPolicy(queryClient: QueryClient, title: string, body: string) {
  const policy = queryClient.getQueryData<Meta>(metaQuery.queryKey)?.push_contents ?? 'full';
  if (policy === 'none') return { title: 'Cenacle', body: i18next.t('notifications.newActivity') };
  if (policy === 'sender') return { title, body: '' };
  return { title, body };
}

/** Desktop notifications are possible and allowed by the person. */
export function canNotify(): boolean {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

/**
 * Tells the person about a message that arrived (a sound, a desktop
 * notification), following their settings — the same rules the server uses
 * for e-mail and web push. A message in the channel they are looking at, while
 * the page is in front, tells nothing.
 */
export function notifyIncoming(
  queryClient: QueryClient,
  message: Message,
  selfId: string,
  openChannel: (channelId: string) => void,
): void {
  if (message.author.id === selfId) return;
  const settings = queryClient.getQueryData<NotificationSettings>(notificationsQuery.queryKey);
  const channels = queryClient.getQueryData<Channel[]>(['channels']);
  const channel = channels?.find((c) => c.id === message.channel_id);
  if (!settings || !channel) return;
  const front = document.visibilityState === 'visible' && document.hasFocus();
  const layout = useLayout.getState();
  const threadOpen =
    layout.detailsOpen &&
    layout.rightView === 'thread' &&
    layout.thread?.rootId === message.root_id;
  const watching = inChannel(message) ? viewedChannel() === channel.id : threadOpen;
  if (watching && front) return;
  const groups = queryClient.getQueryData<GroupList>(groupsQuery(channel.workspace_id).queryKey);
  const mentioned =
    message.mentions.some((p) => p.id === selfId) ||
    mentionsMyGroup(message.body, mentionable(groups?.groups));
  // A reply kept in its thread tells only those it mentions and its followers
  // (as a mention).
  if (!inChannel(message) && !mentioned && !follows(queryClient, message.root_id!)) return;
  const kind = kindOf(channel.kind, mentioned || !inChannel(message));
  const me = queryClient.getQueryData<MyProfile>(myProfileQuery.queryKey);
  if (!notifies(settings, channel, kind, me?.timezone ?? '')) return;

  playSound(soundFor(settings, channel.id, kind), settings.prefs.volume);
  if (settings.prefs.desktop && canNotify() && document.visibilityState !== 'visible') {
    const conversation = channel.kind === 'direct' || channel.kind === 'group';
    const shown = byPolicy(
      queryClient,
      conversation
        ? message.author.display_name
        : `${message.author.display_name} · ${channel.name}`,
      excerpt(message.body),
    );
    const n = new Notification(shown.title, {
      body: shown.body,
      tag: `c-${channel.id}`,
      silent: true,
    });
    n.onclick = () => {
      window.focus();
      openChannel(channel.id);
      n.close();
    };
  }
}

/** An urgent message still waiting for the person's acknowledgement (message.reminder). */
export interface Reminder {
  channel_id: string;
  message_id: string;
  author_name: string;
  channel_name: string;
  channel_kind: string;
  body: string;
}

/**
 * Reminds the person of an urgent message they have not acknowledged: always
 * with a sound and a note in the app, and a desktop notification when the
 * page is not in front. It follows no muting: the sender asked for it.
 */
export function notifyReminder(
  queryClient: QueryClient,
  r: Reminder,
  openChannel: (channelId: string) => void,
): void {
  const settings = queryClient.getQueryData<NotificationSettings>(notificationsQuery.queryKey);
  if (settings) playSound(soundFor(settings, r.channel_id, 'mention'), settings.prefs.volume);
  const conversation = r.channel_kind === 'direct' || r.channel_kind === 'group';
  const title = i18next.t('priority.reminderTitle', { name: r.author_name });
  toast.warning(title, {
    description: r.body,
    duration: 15_000,
    action: { label: i18next.t('priority.open'), onClick: () => openChannel(r.channel_id) },
  });
  if (canNotify() && document.visibilityState !== 'visible') {
    const shown = byPolicy(
      queryClient,
      conversation ? title : `${title} · ${r.channel_name}`,
      r.body,
    );
    const n = new Notification(shown.title, {
      body: shown.body,
      tag: `reminder-${r.message_id}`,
      requireInteraction: true,
    });
    n.onclick = () => {
      window.focus();
      openChannel(r.channel_id);
      n.close();
    };
  }
}

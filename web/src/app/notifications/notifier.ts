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
import { plainOf } from '../compliance/e2e';
import { useLayout } from '../../stores/layout';

/** The channel in view, from the address (/c/<id>). */
function viewedChannel(): string | undefined {
  return /^\/c\/([0-9a-f-]{36})/.exec(window.location.pathname)?.[1];
}

function excerpt(body: string, n = 140): string {
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
    const n = new Notification(
      conversation
        ? message.author.display_name
        : `${message.author.display_name} · ${channel.name}`,
      { body: excerpt(message.body), tag: `c-${channel.id}`, silent: true },
    );
    n.onclick = () => {
      window.focus();
      openChannel(channel.id);
      n.close();
    };
  }
}

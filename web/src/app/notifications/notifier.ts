// SPDX-License-Identifier: Apache-2.0
import type { QueryClient } from '@tanstack/react-query';
import { myProfileQuery, type MyProfile } from '../profile/profiles';
import type { Channel, Message } from '../chat/data';
import {
  kindOf,
  notificationsQuery,
  notifies,
  soundFor,
  type NotificationSettings,
} from './notifications';
import { playSound } from './sounds';

/** The channel in view, from the address (/c/<id>). */
function viewedChannel(): string | undefined {
  return /^\/c\/([0-9a-f-]{36})/.exec(window.location.pathname)?.[1];
}

function excerpt(body: string, n = 140): string {
  const text = body
    .replace(/<@[0-9a-f-]{36}>/g, '@…')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > n ? `${text.slice(0, n)}…` : text;
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
  const watching =
    viewedChannel() === channel.id && document.visibilityState === 'visible' && document.hasFocus();
  if (watching) return;
  const kind = kindOf(
    channel.kind,
    message.mentions.some((p) => p.id === selfId),
  );
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

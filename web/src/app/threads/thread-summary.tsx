// SPDX-License-Identifier: AGPL-3.0-only
import { MessageSquareIcon, PinIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLayout } from '../../stores/layout';
import type { Message } from '../chat/data';
import { UserAvatar } from '../profile/avatar';
import { useProfile } from '../profile/profiles';
import { dateLocale } from '../../i18n/time-format';

/** Under a message with replies: who replied, how many, when; opens the thread. */
export function ThreadSummaryButton({ message }: { message: Message }) {
  const { t, i18n } = useTranslation();
  const openThread = useLayout((s) => s.openThread);
  const thread = message.thread;
  if (!thread) return null;
  const last = new Date(thread.last_reply_at);
  const today = new Date().toDateString() === last.toDateString();
  const when = new Intl.DateTimeFormat(
    dateLocale(i18n.language),
    today ? { hour: '2-digit', minute: '2-digit' } : { dateStyle: 'medium' },
  ).format(last);
  return (
    <button
      type="button"
      data-testid="thread-summary"
      onClick={() => openThread({ channelId: message.channel_id, rootId: message.id })}
      className="mt-1 flex min-h-target items-center gap-2 rounded-md px-1 -ml-1 text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <span className="flex -space-x-1.5" aria-hidden>
        {thread.participants.map((p) => (
          <UserAvatar
            key={p.id}
            userId={p.id}
            name={p.display_name}
            size="xs"
            className="ring-2 ring-background"
          />
        ))}
      </span>
      <span className="font-medium text-primary">
        {t('threads.replies', { count: thread.reply_count })}
      </span>
      <span className="text-xs text-muted-foreground">{t('threads.lastReply', { when })}</span>
    </button>
  );
}

/** Above a reply also sent to the channel: a way to its thread. */
export function RepliedToThread({ message }: { message: Message }) {
  const { t } = useTranslation();
  const openThread = useLayout((s) => s.openThread);
  if (!message.root_id || !message.also_in_channel) return null;
  const rootId = message.root_id;
  return (
    <button
      type="button"
      onClick={() => openThread({ channelId: message.channel_id, rootId })}
      className="flex min-h-target items-center gap-1.5 text-xs text-muted-foreground outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <MessageSquareIcon aria-hidden className="size-3.5" strokeWidth={1.75} />
      {t('threads.repliedToThread')}
    </button>
  );
}

/** Above a pinned message: who pinned it. */
export function PinnedLine({ message }: { message: Message }) {
  const { t } = useTranslation();
  const by = useProfile(message.pinned_by ?? undefined);
  if (!message.pinned_at) return null;
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="pinned">
      <PinIcon aria-hidden className="size-3.5" strokeWidth={1.75} />
      {by?.display_name ? t('pins.pinnedBy', { name: by.display_name }) : t('pins.pinned')}
    </p>
  );
}

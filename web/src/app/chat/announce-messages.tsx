// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Message } from './data';
import { excerpt } from '../notifications/notifier';

/**
 * Says new messages from others to screen readers, one at a time. The message
 * list itself stays quiet: it is virtualized, so rows it mounts while someone
 * scrolls back would otherwise be read out as if they were new.
 */
export function MessageAnnouncer({ messages, selfId }: { messages: Message[]; selfId: string }) {
  const { t } = useTranslation();
  const newest = messages.at(-1);
  // What was there when the channel opened is not news (the list mounts loaded).
  const [said, setSaid] = useState({ seen: newest?.id, text: '' });
  // Older messages loaded while scrolling back are not news either.
  if (newest && (said.seen === undefined || newest.id > said.seen)) {
    const own = newest.author.id === selfId || !!newest.burn;
    setSaid({
      seen: newest.id,
      text: own
        ? said.text
        : t('chat.announce', {
            name: newest.author.display_name,
            text: excerpt(newest.body ?? ''),
          }),
    });
  }
  return (
    <p role="status" className="sr-only" data-testid="announcer">
      {said.text}
    </p>
  );
}

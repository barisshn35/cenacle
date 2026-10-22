// SPDX-License-Identifier: Apache-2.0
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Skeleton } from '@cenacle/ui/components/skeleton';
import { useLayout } from '../../stores/layout';
import { useJump } from '../chat/jump';
import { plainText } from '../search/search';
import { pinsQuery } from './threads';

/** In the channel details: the pinned messages; one jumps to its place. */
export function PinsSection({ channelId }: { channelId: string }) {
  const { t, i18n } = useTranslation();
  const pins = useQuery(pinsQuery(channelId));
  const jump = useJump((s) => s.jump);
  const openThread = useLayout((s) => s.openThread);
  const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' });
  return (
    <section aria-labelledby="pins-title" className="flex flex-col gap-2" data-testid="pins">
      <h3 id="pins-title" className="text-xs font-medium text-muted-foreground uppercase">
        {t('pins.title')}
      </h3>
      {pins.isPending ? (
        <Skeleton className="h-10" />
      ) : (pins.data ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('pins.none')}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {pins.data!.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() =>
                  m.root_id && !m.also_in_channel
                    ? openThread({ channelId, rootId: m.root_id })
                    : jump({ channelId, messageId: m.id })
                }
                className="flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <span className="flex gap-2 text-xs text-muted-foreground">
                  <span className="truncate font-medium text-foreground">
                    {m.author.display_name}
                  </span>
                  <time dateTime={m.created_at}>{date.format(new Date(m.created_at))}</time>
                </span>
                <span className="line-clamp-2 break-words">{plainText(m.body, 160)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

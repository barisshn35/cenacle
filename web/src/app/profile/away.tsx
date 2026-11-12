// SPDX-License-Identifier: AGPL-3.0-only
import { PlaneIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@cenacle/ui/lib/utils';
import { useBackDay } from './format';
import { isAway, useProfile, type OutOfOffice } from './profiles';

/** "Out of office until Mon, Nov 16" (with their words, when asked). */
export function AwayLine({
  away,
  withMessage = false,
  className,
}: {
  away: OutOfOffice;
  withMessage?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const backDay = useBackDay();
  return (
    <div className={cn('grid gap-0.5', className)} data-testid="away">
      <p className="flex items-center gap-1.5 font-medium">
        <PlaneIcon aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />
        {t('profile.away.until', { day: backDay(away.until) })}
      </p>
      {withMessage && away.message && (
        <p className="whitespace-pre-line text-muted-foreground">{away.message}</p>
      )}
    </div>
  );
}

/** Above the composer of a direct conversation with someone out of office. */
export function AwayNotice({ userId, name }: { userId: string; name: string }) {
  const { t } = useTranslation();
  const away = useProfile(userId)?.out_of_office;
  const backDay = useBackDay();
  if (!isAway(away)) return null;
  return (
    <div className="shrink-0 px-4">
      <div
        role="note"
        data-testid="away-notice"
        className="mx-auto flex max-w-3xl items-start gap-2 rounded-t-[10px] border border-b-0 bg-muted/60 px-3 py-2 text-sm"
      >
        <PlaneIcon aria-hidden className="mt-0.5 size-4 shrink-0" strokeWidth={1.75} />
        <p className="min-w-0">
          {t('profile.away.notice', { name, day: backDay(away!.until) })}
          {away!.message && (
            <span className="block whitespace-pre-line text-muted-foreground">{away!.message}</span>
          )}
        </p>
      </div>
    </div>
  );
}

/** Marks a message as an automatic reply; without words of its own it says why. */
export function AutoReplyLabel({
  until,
  name,
  empty,
}: {
  until: string;
  name: string;
  empty: boolean;
}) {
  const { t } = useTranslation();
  const backDay = useBackDay();
  return (
    <>
      <p
        data-testid="auto-reply"
        className="flex items-center gap-1 text-xs font-medium text-muted-foreground"
      >
        <PlaneIcon aria-hidden className="size-3.5" strokeWidth={1.75} />
        {t('profile.away.autoReply')}
      </p>
      {empty && <p>{t('profile.away.defaultReply', { name, day: backDay(until) })}</p>}
    </>
  );
}

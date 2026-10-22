// SPDX-License-Identifier: AGPL-3.0-only
import { useTranslation } from 'react-i18next';
import { cn } from '@cenacle/ui/lib/utils';
import { useLive } from './presence-state';

const EMPTY: never[] = [];

/** "Mert is typing…" under the composer; announced politely. */
export function TypingIndicator({ channelId }: { channelId: string }) {
  const { t } = useTranslation();
  const typists = useLive((s) => s.typing[channelId] ?? EMPTY);
  const names = typists.map((x) => x.name);
  const text =
    names.length === 0
      ? ''
      : names.length === 1
        ? t('chat.typing.one', { name: names[0] })
        : names.length === 2
          ? t('chat.typing.two', { first: names[0], second: names[1] })
          : t('chat.typing.many');
  return (
    <p
      role="status"
      data-testid="typing"
      className={cn('truncate px-1 text-xs text-muted-foreground', !text && 'sr-only')}
    >
      {text}
    </p>
  );
}

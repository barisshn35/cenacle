// SPDX-License-Identifier: AGPL-3.0-only
import { useTranslation } from 'react-i18next';
import { cn } from '@cenacle/ui/lib/utils';
import { useProfile } from './profiles';

/**
 * A person's custom status next to their name: the emoji (or the start of the
 * text when there is none), with the whole status for screen readers and as a
 * tooltip.
 */
export function PersonStatus({ userId, className }: { userId: string; className?: string }) {
  const { t } = useTranslation();
  const status = useProfile(userId)?.status;
  if (!status) return null;
  const full = [status.emoji, status.text].filter(Boolean).join(' ');
  return (
    <span
      className={cn(
        'ml-1.5 inline-block max-w-40 truncate align-bottom text-sm text-muted-foreground',
        className,
      )}
      title={full}
      data-testid="person-status"
    >
      <span aria-hidden>{status.emoji || status.text}</span>
      <span className="sr-only">{t('profile.statusOf', { status: full })}</span>
    </span>
  );
}

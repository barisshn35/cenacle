// SPDX-License-Identifier: AGPL-3.0-only
import { useTranslation } from 'react-i18next';
import { cn } from '@cenacle/ui/lib/utils';
import type { Presence } from '../../lib/sample-data';

/**
 * Presence is shown by color AND shape (WCAG 1.4.1): online = filled dot,
 * away = half-filled, do not disturb = bar, offline = hollow ring.
 */
export function PresenceIndicator({
  presence,
  className,
}: {
  presence: Presence;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        'inline-flex size-3 items-center justify-center rounded-full bg-sidebar',
        className,
      )}
    >
      <svg viewBox="0 0 10 10" className="size-2.5" aria-hidden>
        {presence === 'online' && <circle cx="5" cy="5" r="4" className="fill-presence-online" />}
        {presence === 'away' && (
          <>
            <circle
              cx="5"
              cy="5"
              r="3.25"
              className="fill-none stroke-presence-away"
              strokeWidth="1.5"
            />
            <path d="M5 1.75a3.25 3.25 0 0 1 0 6.5z" className="fill-presence-away" />
          </>
        )}
        {presence === 'dnd' && (
          <>
            <circle cx="5" cy="5" r="4" className="fill-presence-dnd" />
            <rect x="2.5" y="4.25" width="5" height="1.5" rx="0.75" className="fill-sidebar" />
          </>
        )}
        {presence === 'offline' && (
          <circle
            cx="5"
            cy="5"
            r="3.25"
            className="fill-none stroke-presence-offline"
            strokeWidth="1.5"
          />
        )}
      </svg>
      <span className="sr-only">{t(`shell.presence.${presence}`)}</span>
    </span>
  );
}

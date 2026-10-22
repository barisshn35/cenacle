// SPDX-License-Identifier: AGPL-3.0-only
import { useMediaQuery } from '@cenacle/ui/hooks/use-media-query';
import type { Profile } from './profiles';

/** The picture to show: the still first frame when motion is reduced. */
export function usePictureUrl(profile: Pick<Profile, 'avatar_url' | 'avatar_still_url'> | null) {
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  if (!profile?.avatar_url) return null;
  return reduced && profile.avatar_still_url ? profile.avatar_still_url : profile.avatar_url;
}

export const CLEAR = ['never', '30m', '1h', '4h', 'today', 'week'] as const;
export type Clear = (typeof CLEAR)[number];

/** When a status chosen now clears itself. */
export function clearAt(choice: Clear, now = new Date()): string | null {
  const at = new Date(now);
  switch (choice) {
    case 'never':
      return null;
    case '30m':
      return new Date(now.getTime() + 30 * 60_000).toISOString();
    case '1h':
      return new Date(now.getTime() + 60 * 60_000).toISOString();
    case '4h':
      return new Date(now.getTime() + 4 * 60 * 60_000).toISOString();
    case 'today':
      at.setHours(23, 59, 59, 0);
      return at.toISOString();
    case 'week': {
      // The end of Sunday (weeks start on Monday here).
      at.setDate(at.getDate() + ((7 - at.getDay()) % 7));
      at.setHours(23, 59, 59, 0);
      return at.toISOString();
    }
  }
}

/** "3 hours ago" for a past moment. */
export function sinceText(at: Date, locale: string, now = Date.now()): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const s = Math.round((at.getTime() - now) / 1000);
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 7],
    ['week', 4.35],
    ['month', 12],
  ];
  let value = s;
  for (const [unit, size] of steps) {
    if (Math.abs(value) < size)
      return rtf.format(unit === 'second' ? 0 : value, unit === 'second' ? 'minute' : unit);
    value = Math.round(value / size);
  }
  return rtf.format(value, 'year');
}

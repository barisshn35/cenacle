// SPDX-License-Identifier: AGPL-3.0-only
import type { TFunction } from 'i18next';
import { fromRule, WEEKDAYS } from './data';

/** A meeting's repeat in words ("Every Tuesday until 15 December"). */
export function repeatText(t: TFunction, rule: string, start: Date, locale?: string): string {
  const r = fromRule(rule, start);
  if (r.freq === 'none') return '';
  let what: string;
  if (r.freq === 'weekly') {
    const days = WEEKDAYS.filter((d) => r.days.includes(d)).map((d) =>
      t(`meetings.days.long.${d}`),
    );
    const list = new Intl.ListFormat(locale, { type: 'conjunction' }).format(days);
    what = t('meetings.repeats.weekly', { count: r.interval, days: list });
  } else if (r.freq === 'monthly') {
    what = t('meetings.repeats.monthly', { count: r.interval, day: start.getDate() });
  } else {
    what = t('meetings.repeats.daily', { count: r.interval });
  }
  if (r.end === 'count') return t('meetings.repeats.times', { what, count: r.count });
  const until = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long' }).format(
    new Date(`${r.until}T12:00:00`),
  );
  return t('meetings.repeats.until', { what, date: until });
}

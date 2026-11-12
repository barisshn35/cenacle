// SPDX-License-Identifier: AGPL-3.0-only
// Meetings and calendar (ADR 0054).
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { apiFetch, type components } from '@cenacle/core/api';

export type Meeting = components['schemas']['Meeting'];
export type MeetingInput = components['schemas']['MeetingInput'];
export type MeetingCreate = components['schemas']['MeetingCreate'];
export type CalendarItem = components['schemas']['CalendarItem'];
export type Answer = 'yes' | 'maybe' | 'no';

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const calendarQuery = (from: Date, to: Date) =>
  queryOptions({
    queryKey: ['calendar', from.toISOString(), to.toISOString()],
    queryFn: () =>
      apiFetch<{ items: CalendarItem[] }>(
        `/api/calendar?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
      ).then((r) => r.items),
    staleTime: 60_000,
  });

export const meetingQuery = (id: string) =>
  queryOptions({
    queryKey: ['meeting', id],
    queryFn: () => apiFetch<Meeting>(`/api/meetings/${id}`),
  });

export const createMeeting = (body: MeetingCreate) =>
  apiFetch<Meeting>('/api/meetings', json(body));
export const updateMeeting = (id: string, body: MeetingInput) =>
  apiFetch<Meeting>(`/api/meetings/${id}`, json(body, 'PUT'));
export const cancelMeeting = (id: string) =>
  apiFetch<void>(`/api/meetings/${id}`, { method: 'DELETE' });
export const skipOccurrence = (id: string, occurrence: string) =>
  apiFetch<Meeting>(`/api/meetings/${id}/skip`, json({ occurrence }));
export const answerMeeting = (id: string, response: Answer) =>
  apiFetch<void>(`/api/meetings/${id}/response`, json({ response }, 'PUT'));
export const meetingFileURL = (id: string) => `/api/meetings/${id}/ics`;

export const calendarFeedQuery = queryOptions({
  queryKey: ['calendar-feed'],
  queryFn: () => apiFetch<{ exists: boolean; created_at?: string | null }>('/api/me/calendar-feed'),
});
export const createCalendarFeed = () =>
  apiFetch<{ url: string }>('/api/me/calendar-feed', { method: 'POST' });
export const deleteCalendarFeed = () =>
  apiFetch<void>('/api/me/calendar-feed', { method: 'DELETE' });

/** Tells the server the app's language (for e-mails). */
export const setServerLanguage = (language: 'en' | 'tr' | null) =>
  apiFetch<void>('/api/me/language', json({ language }, 'PUT'));

/** A meeting changed: the calendar and that meeting are read again. */
export function meetingsChanged(client: QueryClient, id?: string): void {
  void client.invalidateQueries({ queryKey: ['calendar'] });
  if (id) void client.invalidateQueries({ queryKey: ['meeting', id] });
}

/** Join opens this long before an occurrence (ADR 0054). */
export const JOIN_EARLY_MS = 5 * 60_000;

/** Whether an occurrence can be joined now. */
export const joinable = (start: Date, end: Date, now = Date.now()) =>
  now >= start.getTime() - JOIN_EARLY_MS && now < end.getTime();

// --- dates ------------------------------------------------------------------

export const DAY_MS = 24 * 3600_000;

export function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** The Monday of the week (weeks start on Monday). */
export function startOfWeek(d: Date): Date {
  const x = startOfDay(d);
  return addDays(x, -((x.getDay() + 6) % 7));
}

/** The six weeks shown for the month of d. */
export function monthGrid(d: Date): { from: Date; to: Date } {
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const from = startOfWeek(first);
  return { from, to: addDays(from, 42) };
}

export const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/** "2026-11-17" in local time, for date inputs. */
export function dateInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function timeInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Local date and time inputs as an instant. */
export function fromInputs(date: string, time: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [h, min] = time.split(':').map(Number);
  return new Date(y!, m! - 1, d!, h!, min!);
}

// --- repeat -----------------------------------------------------------------

export type Freq = 'none' | 'daily' | 'weekly' | 'monthly';
export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface Repeat {
  freq: Freq;
  interval: number;
  days: Weekday[];
  /** Ends on a day (local date) or after a number of times. */
  end: 'until' | 'count';
  until: string;
  count: number;
}

/** The weekday code of a date. */
export const weekdayOf = (d: Date): Weekday => WEEKDAYS[(d.getDay() + 6) % 7]!;

export function defaultRepeat(start: Date): Repeat {
  return {
    freq: 'none',
    interval: 1,
    days: [weekdayOf(start)],
    end: 'until',
    until: dateInput(addDays(start, 8 * 7)),
    count: 10,
  };
}

/** The rule for the server ('' when it does not repeat). */
export function toRule(r: Repeat, start: Date): string {
  if (r.freq === 'none') return '';
  const parts = [`FREQ=${r.freq.toUpperCase()}`];
  if (r.interval > 1) parts.push(`INTERVAL=${r.interval}`);
  if (r.freq === 'weekly') {
    const days = r.days.length ? r.days : [weekdayOf(start)];
    parts.push(`BYDAY=${WEEKDAYS.filter((d) => days.includes(d)).join(',')}`);
  }
  if (r.end === 'count') parts.push(`COUNT=${r.count}`);
  else {
    // Until the end of that day (local), as the server wants it: in UTC.
    const end = fromInputs(r.until, '23:59');
    parts.push(
      `UNTIL=${end
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}/, '')}`,
    );
  }
  return parts.join(';');
}

/** The form's repeat for a stored rule. */
export function fromRule(rule: string, start: Date): Repeat {
  const r = defaultRepeat(start);
  if (!rule) return r;
  for (const part of rule.split(';')) {
    const [k, v = ''] = part.split('=');
    if (k === 'FREQ') r.freq = v.toLowerCase() as Freq;
    if (k === 'INTERVAL') r.interval = Number(v) || 1;
    if (k === 'BYDAY') r.days = v.split(',') as Weekday[];
    if (k === 'COUNT') {
      r.end = 'count';
      r.count = Number(v) || 1;
    }
    if (k === 'UNTIL') {
      const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(v);
      if (m) {
        const at = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!));
        r.end = 'until';
        r.until = dateInput(at);
      }
    }
  }
  return r;
}

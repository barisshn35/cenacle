// SPDX-License-Identifier: AGPL-3.0-only
import { queryOptions } from '@tanstack/react-query';
import { apiFetch, type components } from '@cenacle/core/api';

export type NotificationSettings = components['schemas']['NotificationSettings'];
export type NotificationPrefs = components['schemas']['NotificationPrefs'];
export type ChannelNotification = components['schemas']['ChannelNotification'];
export type UserSound = components['schemas']['UserSound'];

const json = (body: unknown, method: string): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const notificationsQuery = queryOptions({
  queryKey: ['me', 'notifications'],
  queryFn: () => apiFetch<NotificationSettings>('/api/me/notifications'),
  staleTime: 5 * 60_000,
});

export const savePrefs = (prefs: NotificationPrefs) =>
  apiFetch<NotificationSettings>('/api/me/notifications', json(prefs, 'PUT'));

export const setChannelNotifications = (
  channelId: string,
  n: Omit<ChannelNotification, 'channel_id'>,
) => apiFetch<ChannelNotification>(`/api/channels/${channelId}/notifications`, json(n, 'PUT'));

export const setWorkspaceMute = (workspaceId: string, mutedUntil: string | null) =>
  apiFetch(
    `/api/workspaces/${workspaceId}/notifications`,
    json({ muted_until: mutedUntil }, 'PUT'),
  );

export const soundsQuery = queryOptions({
  queryKey: ['me', 'sounds'],
  queryFn: () => apiFetch<{ sounds: UserSound[] }>('/api/me/sounds').then((r) => r.sounds),
  staleTime: Infinity,
});
export const uploadSound = (name: string, file: Blob) =>
  apiFetch<UserSound>(`/api/me/sounds?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
export const deleteSound = (id: string) =>
  apiFetch<void>(`/api/me/sounds/${id}`, { method: 'DELETE' });

/** "For good" when muting: far in the future. */
export const FOREVER = '9999-12-31T00:00:00Z';

/** When a mute or pause chosen now ends. */
export function untilOf(
  choice: '30m' | '1h' | '2h' | '8h' | 'tomorrow' | 'week' | 'forever',
  now = new Date(),
) {
  const at = new Date(now);
  switch (choice) {
    case '30m':
      return new Date(now.getTime() + 30 * 60_000).toISOString();
    case '1h':
      return new Date(now.getTime() + 60 * 60_000).toISOString();
    case '2h':
      return new Date(now.getTime() + 2 * 60 * 60_000).toISOString();
    case '8h':
      return new Date(now.getTime() + 8 * 60 * 60_000).toISOString();
    case 'tomorrow':
      at.setDate(at.getDate() + 1);
      at.setHours(8, 0, 0, 0);
      return at.toISOString();
    case 'week':
      at.setDate(at.getDate() + 7);
      return at.toISOString();
    case 'forever':
      return FOREVER;
  }
}

export const isActive = (until: string | null | undefined, now = Date.now()) =>
  !!until && new Date(until).getTime() > now;

// --- the same rules as the server (internal/notify) ----------------------------

export type Kind = 'message' | 'mention' | 'direct';

export function kindOf(channelKind: string, mentioned: boolean): Kind {
  if (channelKind === 'direct' || channelKind === 'group') return 'direct';
  return mentioned ? 'mention' : 'message';
}

/** Hours and minutes of a day in a time zone. */
function localParts(now: Date, timeZone: string): { minutes: number; day: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || undefined,
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return {
      minutes: Number(get('hour')) * 60 + Number(get('minute')),
      day: days.indexOf(get('weekday')),
    };
  } catch {
    return { minutes: now.getHours() * 60 + now.getMinutes(), day: now.getDay() };
  }
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export function inQuietHours(p: NotificationPrefs, now: Date, timeZone: string): boolean {
  const q = p.quiet_hours;
  if (!q.enabled) return false;
  const { minutes, day } = localParts(now, timeZone);
  const start = toMinutes(q.start);
  const end = toMinutes(q.end);
  if (start === end) return false;
  if (start < end) return q.days.includes(day) && minutes >= start && minutes < end;
  return (
    (minutes >= start && q.days.includes(day)) || (minutes < end && q.days.includes((day + 6) % 7))
  );
}

/** Whether a message of a kind notifies now (sounds, desktop notifications). */
export function notifies(
  settings: NotificationSettings,
  channel: { id: string; workspace_id: string },
  kind: Kind,
  timeZone: string,
  now = new Date(),
): boolean {
  const p = settings.prefs;
  if (isActive(p.paused_until, now.getTime())) return false;
  const ch = settings.channels.find((c) => c.channel_id === channel.id);
  if (isActive(ch?.muted_until, now.getTime())) return false;
  const ws = settings.workspaces.find((w) => w.workspace_id === channel.workspace_id);
  if (isActive(ws?.muted_until, now.getTime())) return false;
  if (inQuietHours(p, now, timeZone)) return false;
  let level = ch?.level ?? 'default';
  if (level === 'default') level = kind === 'direct' ? 'all' : p.default_level;
  if (level === 'all') return true;
  if (level === 'mentions') return kind !== 'message';
  return false;
}

/** The sound a message makes: the channel's own, else the kind's. */
export function soundFor(settings: NotificationSettings, channelId: string, kind: Kind): string {
  const own = settings.channels.find((c) => c.channel_id === channelId)?.sound;
  if (own) return own;
  return settings.prefs.sounds[kind];
}

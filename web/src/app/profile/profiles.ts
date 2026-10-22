// SPDX-License-Identifier: Apache-2.0
import { queryOptions, useQuery, type QueryClient } from '@tanstack/react-query';
import { apiFetch, type components } from '@cenacle/core/api';

export type Profile = components['schemas']['Profile'];
export type MyProfile = components['schemas']['MyProfile'];
export type CustomStatus = components['schemas']['CustomStatus'];

const json = (body: unknown, method: string): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// --- many profiles in one request ------------------------------------------

type Waiting = { resolve: (p: Profile | null) => void; reject: (e: unknown) => void };
let pending = new Map<string, Waiting[]>();
let timer: ReturnType<typeof setTimeout> | undefined;

function flush() {
  const batch = pending;
  pending = new Map();
  timer = undefined;
  const ids = [...batch.keys()];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    apiFetch<{ profiles: Profile[] }>(`/api/profiles?ids=${chunk.join(',')}`).then(
      ({ profiles }) => {
        const byId = new Map(profiles.map((p) => [p.id, p]));
        // People one may not see answer null (their messages still show the name).
        for (const id of chunk) for (const w of batch.get(id)!) w.resolve(byId.get(id) ?? null);
      },
      (err) => {
        for (const id of chunk) for (const w of batch.get(id)!) w.reject(err);
      },
    );
  }
}

/** Reads a profile; the reads of one moment go out together. */
export function loadProfile(id: string): Promise<Profile | null> {
  return new Promise((resolve, reject) => {
    const list = pending.get(id) ?? [];
    list.push({ resolve, reject });
    pending.set(id, list);
    timer ??= setTimeout(flush, 10);
  });
}

export const profileQuery = (id: string) =>
  queryOptions({
    queryKey: ['profile', id],
    queryFn: () => loadProfile(id),
    staleTime: 10 * 60_000,
  });

export function useProfile(id: string | undefined) {
  return useQuery({ ...profileQuery(id ?? ''), enabled: Boolean(id) }).data ?? null;
}

export const myProfileQuery = queryOptions({
  queryKey: ['me', 'profile'],
  queryFn: () => apiFetch<MyProfile>('/api/me/profile'),
  staleTime: 5 * 60_000,
});

/** A profile changed (user.updated): read it again. */
export async function profileChanged(queryClient: QueryClient, userId: string, selfId: string) {
  await queryClient.invalidateQueries({ queryKey: ['profile', userId] });
  if (userId === selfId) await queryClient.invalidateQueries({ queryKey: ['me', 'profile'] });
}

/** After a change of one's own profile: both views of it are new. */
export function saved(queryClient: QueryClient, me: MyProfile) {
  queryClient.setQueryData(myProfileQuery.queryKey, me);
  void queryClient.invalidateQueries({ queryKey: ['profile', me.id] });
}

export const updateMyProfile = (patch: {
  username?: string;
  timezone?: string;
  show_last_seen?: boolean;
}) => apiFetch<MyProfile>('/api/me/profile', json(patch, 'PATCH'));

export const setCustomStatus = (status: CustomStatus) =>
  apiFetch<MyProfile>('/api/me/status', json(status, 'PUT'));
export const clearCustomStatus = () => apiFetch<void>('/api/me/status', { method: 'DELETE' });

export const uploadAvatar = (file: Blob) =>
  apiFetch<MyProfile>('/api/me/avatar', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
export const deleteAvatar = () => apiFetch<void>('/api/me/avatar', { method: 'DELETE' });

/** The browser's time zone (IANA), or ''. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    return '';
  }
}

/** "14:05 (GMT+3)" in a time zone; null when it is unknown. */
export function localTime(timeZone: string, locale: string, now = new Date()): string | null {
  if (!timeZone) return null;
  try {
    const time = new Intl.DateTimeFormat(locale, { timeZone, hour: '2-digit', minute: '2-digit' });
    const offset = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' })
      .formatToParts(now)
      .find((p) => p.type === 'timeZoneName')?.value;
    return `${time.format(now)} (${offset === 'GMT' ? 'GMT+0' : offset})`;
  } catch {
    return null;
  }
}

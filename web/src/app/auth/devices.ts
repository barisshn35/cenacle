// SPDX-License-Identifier: AGPL-3.0-only
import { queryOptions } from '@tanstack/react-query';
import { apiFetch, type components } from '@cenacle/core/api';

export type DeviceSession = components['schemas']['DeviceSession'];

/** The user's signed-in devices (sessions), most recently used first. */
export const devicesQuery = queryOptions({
  queryKey: ['devices'],
  queryFn: () => apiFetch<{ sessions: DeviceSession[] }>('/api/sessions').then((r) => r.sessions),
});

export const endDevice = (id: string) =>
  apiFetch<void>(`/api/sessions/${id}`, { method: 'DELETE' });

export const endAllDevices = (keepCurrent: boolean) =>
  apiFetch<{ ended: number }>('/api/sessions/end-all', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keep_current: keepCurrent }),
  });

/** "Firefox on Windows" from a user agent, as far as it can be told. */
export function describeDevice(userAgent: string): { browser?: string; os?: string } {
  const ua = userAgent;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : /Electron\//.test(ua)
              ? 'Cenacle'
              : undefined;
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad|iOS/.test(ua)
        ? 'iOS'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : undefined;
  return { browser, os };
}

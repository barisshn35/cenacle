// SPDX-License-Identifier: AGPL-3.0-only
import { queryOptions } from '@tanstack/react-query';
import { ApiError, apiFetch } from '@cenacle/core/api';

export interface Meta {
  web_app: boolean;
  /** What the apps' own notifications may show (the notification policy). */
  push_contents?: 'full' | 'sender' | 'none';
  /** The operator's privacy policy, when they set one. */
  privacy_url?: string;
}

export interface WebAppSetting {
  enabled: boolean;
  /** CENACLE_WEB_APP decides it on the server. */
  forced: boolean;
}

/** The address of this server, as people type it into the apps. */
export const serverAddress = () => window.location.host;

/** What the server offers before signing in: whether browsers may use it. */
export const metaQuery = queryOptions({
  queryKey: ['meta'],
  queryFn: () => apiFetch<Meta>('/api/meta'),
  staleTime: 60_000,
});

export const webAppQuery = queryOptions({
  queryKey: ['admin', 'web-app'],
  queryFn: () => apiFetch<WebAppSetting>('/api/admin/web-app'),
});

export function setWebApp(enabled: boolean) {
  return apiFetch<WebAppSetting>('/api/admin/web-app', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
}

/** The server turned this browser away because the web app is off. */
export function isWebAppOff(err: unknown): boolean {
  return err instanceof ApiError && err.problem.code === 'web_app_off';
}

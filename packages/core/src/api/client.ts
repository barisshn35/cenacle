// SPDX-License-Identifier: Apache-2.0
import type { components } from './schema';
import { isProblem, type Problem } from './index';

export type Session = components['schemas']['Session'];
export type User = components['schemas']['User'];
export type Logout = components['schemas']['Logout'];

/** A failed API call. `problem` is the server's RFC 9457 body, or a synthesized one. */
export class ApiError extends Error {
  readonly problem: Problem;
  /** Seconds to wait before trying again (Retry-After), if the server said. */
  readonly retryAfter: number | undefined;

  constructor(problem: Problem, retryAfter?: number) {
    super(`${problem.status} ${problem.code}`);
    this.name = 'ApiError';
    this.problem = problem;
    this.retryAfter = retryAfter;
  }

  get status(): number {
    return this.problem.status;
  }
}

/** Status 0: the server could not be reached at all. */
export const NETWORK_ERROR = 'network_error';

export function isUnauthenticated(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

/**
 * Calls the chat API on the app's own origin. The session cookie travels
 * automatically; errors become ApiError.
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: { Accept: 'application/json', ...init.headers },
    });
  } catch {
    throw new ApiError({
      type: 'about:blank',
      title: 'Network error',
      status: 0,
      code: NETWORK_ERROR,
    });
  }
  const body: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const retryAfter = Number(res.headers.get('Retry-After'));
    throw new ApiError(
      isProblem(body)
        ? body
        : {
            type: 'about:blank',
            title: res.statusText,
            status: res.status,
            code: `http_${res.status}`,
          },
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    );
  }
  return body as T;
}

export function getSession(): Promise<Session> {
  return apiFetch<Session>('/api/session');
}

export function logout(): Promise<Logout> {
  return apiFetch<Logout>('/api/auth/logout', { method: 'POST' });
}

/**
 * Returns `path` if it is a path inside the app, otherwise "/". Mirrors the
 * server's check: absolute and scheme-relative URLs are rejected.
 */
export function safeReturnPath(path: string | undefined): string {
  if (!path || path.length > 2048 || !path.startsWith('/') || path.startsWith('//')) return '/';
  // Backslashes and control characters (browsers ignore tabs and newlines in URLs).
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f]/.test(path)) return '/';
  return path;
}

/**
 * URL that starts sign-in with Cenacle ID and comes back to `returnTo`.
 * `theme` is the theme chosen in the app, for Cenacle ID's pages; left out
 * when the app follows the system.
 */
export function signInUrl(returnTo?: string, theme?: 'light' | 'dark'): string {
  const target = safeReturnPath(returnTo);
  const query = new URLSearchParams();
  if (target !== '/') query.set('return_to', target);
  if (theme) query.set('theme', theme);
  const q = query.toString().replace(/\+/g, '%20');
  return q ? `/api/auth/login?${q}` : '/api/auth/login';
}

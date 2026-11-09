// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  apiFetch,
  getSession,
  isUnauthenticated,
  logout,
  safeReturnPath,
  signInUrl,
} from '../src/api';

function respond(status: number, body: unknown, contentType = 'application/json') {
  return vi.fn().mockResolvedValue(
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': contentType },
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('apiFetch', () => {
  it('returns the JSON body and sends same-origin credentials', async () => {
    const fetchMock = respond(200, { user: { id: 'u1' } });
    vi.stubGlobal('fetch', fetchMock);
    await expect(getSession()).resolves.toEqual({ user: { id: 'u1' } });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/session',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
  });

  it('turns problem responses into ApiError', async () => {
    const problem = {
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      code: 'unauthenticated',
      request_id: 'r1',
    };
    vi.stubGlobal('fetch', respond(401, problem, 'application/problem+json'));
    const err = await getSession().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).problem).toEqual(problem);
    expect(isUnauthenticated(err)).toBe(true);
  });

  it('synthesizes a problem for other failures', async () => {
    vi.stubGlobal('fetch', respond(502, undefined, 'text/html'));
    const err = (await apiFetch('/api/x').catch((e: unknown) => e)) as ApiError;
    expect(err.problem).toMatchObject({ status: 502, code: 'http_502' });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const net = (await logout().catch((e: unknown) => e)) as ApiError;
    expect(net.problem).toMatchObject({ status: 0, code: 'network_error' });
    expect(isUnauthenticated(net)).toBe(false);
  });

  it('passes on Retry-After', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ type: 'about:blank', title: '', status: 429, code: 'rate_limited' }),
          {
            status: 429,
            headers: { 'content-type': 'application/problem+json', 'retry-after': '7' },
          },
        ),
      ),
    );
    const err = (await apiFetch('/api/x').catch((e: unknown) => e)) as ApiError;
    expect(err.retryAfter).toBe(7);
  });

  it('logs out with POST', async () => {
    const fetchMock = respond(200, { end_session_url: '' });
    vi.stubGlobal('fetch', fetchMock);
    await logout();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/logout',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('sign-in URLs', () => {
  it.each([
    ['/c/general?x=1', '/c/general?x=1'],
    [undefined, '/'],
    ['//evil.example', '/'],
    ['/\\evil.example', '/'],
    ['https://evil.example', '/'],
    ['c/general', '/'],
  ])('safeReturnPath(%s) = %s', (input, want) => {
    expect(safeReturnPath(input)).toBe(want);
  });

  it('builds the login URL', () => {
    expect(signInUrl('/')).toBe('/api/auth/login');
    expect(signInUrl('/c/a b')).toBe('/api/auth/login?return_to=%2Fc%2Fa%20b');
    expect(signInUrl('/', 'light')).toBe('/api/auth/login?theme=light');
    expect(signInUrl('/c/x', 'dark')).toBe('/api/auth/login?return_to=%2Fc%2Fx&theme=dark');
  });
});

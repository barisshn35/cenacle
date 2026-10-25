// SPDX-License-Identifier: AGPL-3.0-only
import formbody from '@fastify/formbody';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { NOTICE_COOKIE, registerSigninNotice } from '../src/ui/notice.ts';

const ISSUER = 'https://id.example.com';

async function app() {
  const a = Fastify();
  a.decorateRequest('cookieValue', function (this: { headers: { cookie?: string } }, name: string) {
    const m = new RegExp(`(?:^|; )${name}=([^;]*)`).exec(this.headers.cookie ?? '');
    return m?.[1];
  });
  await a.register(formbody);
  registerSigninNotice(a, {
    text: 'Authorized use only.\nUse is monitored.',
    issuer: ISSUER,
    formActionOrigins: [],
  });
  a.get('/account', async () => 'account');
  a.get('/interaction/:uid', async () => 'sign-in form');
  a.post('/account/signin', async () => 'signed in');
  a.get('/healthz', async () => 'ok');
  return a;
}

const accepted = { cookie: `${NOTICE_COOKIE}=accepted` };

describe('sign-in notice', () => {
  it('comes before every way to sign in', async () => {
    const a = await app();
    const page = await a.inject({ url: '/interaction/abc_123' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('data-testid="signin-notice"');
    expect(page.body).toContain('Authorized use only.');
    expect(page.body).toContain('value="/interaction/abc_123"');
    expect((await a.inject({ method: 'POST', url: '/account/signin' })).statusCode).toBe(403);
    expect((await a.inject({ url: '/healthz' })).body).toBe('ok');
  });

  it('is accepted once per browser session, same-origin only', async () => {
    const a = await app();
    const cross = await a.inject({
      method: 'POST',
      url: '/notice',
      headers: { 'sec-fetch-site': 'cross-site' },
      payload: { next: '/account' },
    });
    expect(cross.statusCode).toBe(403);
    const ok = await a.inject({
      method: 'POST',
      url: '/notice',
      headers: { 'sec-fetch-site': 'same-origin', origin: ISSUER },
      payload: { next: '/interaction/abc_123' },
    });
    expect(ok.statusCode).toBe(303);
    expect(ok.headers.location).toBe('/interaction/abc_123');
    expect(String(ok.headers['set-cookie'])).toMatch(
      /^cenacle_notice=accepted; Path=\/; HttpOnly; SameSite=Lax; Secure$/,
    );
    // Elsewhere is not a place to go back to.
    const away = await a.inject({
      method: 'POST',
      url: '/notice',
      headers: { 'sec-fetch-site': 'same-origin' },
      payload: { next: 'https://evil.example/' },
    });
    expect(away.headers.location).toBe('/account');
    expect((await a.inject({ url: '/account', headers: accepted })).body).toBe('account');
    expect(
      (await a.inject({ method: 'POST', url: '/account/signin', headers: accepted })).body,
    ).toBe('signed in');
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// The setup of two-step verification on the account pages.
import formbody from '@fastify/formbody';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { AuditLog } from '../src/accounts/audit.ts';
import type { MfaStore } from '../src/accounts/mfa.ts';
import type { User, UserStore } from '../src/accounts/users.ts';
import { registerAccount } from '../src/account/routes.ts';
import { ACCOUNT_COOKIE, signAccount } from '../src/account/session.ts';

const ISSUER = 'https://id.example.com';
const KEYS = ['a-cookie-key-for-the-tests-only'];
const ADA = {
  id: '01900000-0000-7000-8000-000000000002',
  email: 'ada@example.com',
  username: null,
  displayName: 'Ada',
  disabled: false,
} as unknown as User;

describe('setting up two-step verification', () => {
  it('shows a new secret for every setup and the same one after a wrong code', async () => {
    let pending: string | null = 'SHOWNEARLIERAAAA';
    let minted = 0;
    const app = Fastify();
    app.decorateRequest(
      'cookieValue',
      function (this: { headers: { cookie?: string } }, name: string) {
        const m = new RegExp(`(?:^|; )${name}=([^;]*)`).exec(this.headers.cookie ?? '');
        return m?.[1];
      },
    );
    await app.register(formbody);
    await registerAccount(app, {
      users: { findById: async (id: string) => (id === ADA.id ? ADA : null) } as UserStore,
      mfa: {
        enabled: async () => false,
        pendingSecret: async () =>
          pending ? { secret: pending, uri: `otpauth://totp/x?secret=${pending}` } : null,
        beginSetup: async () => {
          pending = `MINTEDSECRET${++minted}AAA`;
          return { secret: pending, uri: `otpauth://totp/x?secret=${pending}` };
        },
        confirmSetup: async () => null,
      } as unknown as MfaStore,
      audit: { record: async () => {} } as unknown as AuditLog,
      issuer: ISSUER,
      cookieKeys: KEYS,
      formActionOrigins: [],
    });
    // The secret is shown in groups (and in the QR code's otpauth URI).
    const shown = (body: string) => body.replace(/\s/g, '');
    const cookie = `${ACCOUNT_COOKIE}=${signAccount(KEYS, ADA.id)}`;

    const first = await app.inject({ url: '/account/two-step/setup', headers: { cookie } });
    expect(first.statusCode).toBe(200);
    expect(shown(first.body)).not.toContain('SHOWNEARLIERAAAA');
    expect(shown(first.body)).toContain('MINTEDSECRET1AAA');

    const wrong = await app.inject({
      method: 'POST',
      url: '/account/two-step/setup',
      headers: {
        cookie,
        origin: ISSUER,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'code=000000',
    });
    expect(wrong.statusCode).toBe(401);
    expect(shown(wrong.body)).toContain('MINTEDSECRET1AAA');

    const again = await app.inject({ url: '/account/two-step/setup', headers: { cookie } });
    expect(shown(again.body)).toContain('MINTEDSECRET2AAA');
    await app.close();
  });
});

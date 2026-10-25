// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import formbody from '@fastify/formbody';
import Fastify from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/accounts/audit.ts';
import { MfaStore } from '../src/accounts/mfa.ts';
import { PolicyStore, type SignInPolicy } from '../src/accounts/policy.ts';
import { UserStore, type User } from '../src/accounts/users.ts';
import { ACCOUNT_COOKIE, signAccount } from '../src/account/session.ts';
import { registerAdmin } from '../src/admin/routes.ts';
import { SourceStore } from '../src/directory/store.ts';
import { oidcConfigSchema } from '../src/federation/config.ts';
import { ProviderStore } from '../src/federation/store.ts';
import { hasTestDatabase, openTestDatabase, resetTestDatabase } from './helpers/db.ts';

const ISSUER = 'https://id.example.com';
const KEYS = ['a-cookie-key-for-the-tests-only'];
const ADMIN = {
  id: '01900000-0000-7000-8000-000000000001',
  isAdmin: true,
  disabled: false,
  fromProvider: false,
} as User;

async function app(policy: SignInPolicy, twoStep: boolean) {
  const a = Fastify();
  a.decorateRequest('cookieValue', function (this: { headers: { cookie?: string } }, name: string) {
    const m = new RegExp(`(?:^|; )${name}=([^;]*)`).exec(this.headers.cookie ?? '');
    return m?.[1];
  });
  await a.register(formbody);
  const recorded: string[] = [];
  await registerAdmin(a, {
    pool: {} as pg.Pool,
    users: { findById: async (id: string) => (id === ADMIN.id ? ADMIN : null) } as UserStore,
    mfa: { enabled: async () => twoStep } as unknown as MfaStore,
    audit: { record: async (action: string) => void recorded.push(action) } as unknown as AuditLog,
    sources: {} as SourceStore,
    issuer: ISSUER,
    cookieKeys: KEYS,
    formActionOrigins: [],
    policy: { get: async () => policy, set: async () => {} } as unknown as PolicyStore,
  });
  return { a, recorded };
}

const cookie = { cookie: `${ACCOUNT_COOKIE}=${signAccount(KEYS, ADMIN.id)}` };
const post = {
  ...cookie,
  'sec-fetch-site': 'same-origin',
  origin: ISSUER,
  'content-type': 'application/x-www-form-urlencoded',
};

describe('administration and the sign-in policy', () => {
  it('sends an administrator without a required two-step to set it up first', async () => {
    const { a, recorded } = await app({ requireTwoStep: true, passkeys: false }, false);
    const get = await a.inject({ url: '/account/admin/sign-in', headers: cookie });
    expect(get.statusCode).toBe(303);
    expect(get.headers.location).toBe('/account/two-step/setup');
    const change = await a.inject({
      method: 'POST',
      url: '/account/admin/sign-in',
      headers: post,
      payload: 'passkeys=on',
    });
    expect(change.statusCode).toBe(303);
    expect(change.headers.location).toBe('/account/two-step/setup');
    expect(recorded).toEqual([]);
  });

  it('lets the administrator in once two-step is set up, or when it is not required', async () => {
    for (const [requireTwoStep, twoStep] of [
      [true, true],
      [false, false],
    ]) {
      const { a } = await app({ requireTwoStep: requireTwoStep!, passkeys: false }, twoStep!);
      const res = await a.inject({ url: '/account/admin/sign-in', headers: cookie });
      expect(res.statusCode).toBe(200);
    }
  });
});

describe.skipIf(!hasTestDatabase)('administration ends sessions (database)', () => {
  let pool: pg.Pool;
  let policies: PolicyStore;
  let original: SignInPolicy;
  const a = Fastify();

  beforeAll(async () => {
    pool = await openTestDatabase();
    policies = new PolicyStore(pool);
    original = await policies.get();
    a.decorateRequest(
      'cookieValue',
      function (this: { headers: { cookie?: string } }, name: string) {
        const m = new RegExp(`(?:^|; )${name}=([^;]*)`).exec(this.headers.cookie ?? '');
        return m?.[1];
      },
    );
    await a.register(formbody);
    await registerAdmin(a, {
      pool,
      users: new UserStore(pool),
      mfa: new MfaStore(pool, randomBytes(32)),
      audit: new AuditLog(pool),
      sources: new SourceStore(pool, randomBytes(32)),
      issuer: ISSUER,
      cookieKeys: KEYS,
      formActionOrigins: [],
      policy: policies,
    });
    await a.ready();
  });
  afterAll(async () => {
    await policies.set(original);
    await a.close();
    await pool.end();
  });
  beforeEach(async () => {
    await resetTestDatabase(pool);
    await policies.set({ requireTwoStep: false, passkeys: false });
  });

  const person = async (email: string, twoStep: boolean, sourceId: string | null = null) => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, display_name, source_id, external_id, is_admin, totp_enabled_at)
       VALUES ($1::text, $1::text, $2::uuid, CASE WHEN $2::uuid IS NOT NULL THEN $1::text END,
               $1::text LIKE 'admin%', CASE WHEN $3 THEN now() END)
       RETURNING id`,
      [email, sourceId, twoStep],
    );
    const id = rows[0]!.id;
    await pool.query(`INSERT INTO oidc_payloads (model, id, payload) VALUES ('Session', $1, $2)`, [
      `s-${id}`,
      JSON.stringify({ accountId: id }),
    ]);
    return id;
  };
  const sessions = async () =>
    (
      await pool.query<{ id: string }>(
        `SELECT payload->>'accountId' AS id FROM oidc_payloads ORDER BY 1`,
      )
    ).rows.map((r) => r.id);
  const send = (adminId: string, url: string, payload = '') =>
    a.inject({
      method: 'POST',
      url,
      headers: { ...post, cookie: `${ACCOUNT_COOKIE}=${signAccount(KEYS, adminId)}` },
      payload,
    });

  it('when two-step becomes required, and when an administrator resets it', async () => {
    const provider = await new ProviderStore(pool, randomBytes(32)).create({
      kind: 'oidc',
      name: 'Entra ID',
      enabled: true,
      secret: 'client-secret',
      config: oidcConfigSchema.parse({ issuer: 'https://login.example.com', clientId: 'c' }),
    });
    const admin = await person('admin@example.com', true);
    const without = await person('without@example.com', false);
    const withTwoStep = await person('with@example.com', true);
    const federated = await person('federated@example.com', false, provider.id);

    const on = await send(admin, '/account/admin/sign-in', 'require_two_step=on');
    expect(on.statusCode).toBe(303);
    expect((await sessions()).sort()).toEqual([admin, withTwoStep, federated].sort());

    const reset = await send(admin, `/account/admin/accounts/${withTwoStep}/reset-two-step`);
    expect(reset.statusCode).toBe(303);
    expect((await sessions()).sort()).toEqual([admin, federated].sort());
    expect(without).toBeTruthy();
  });
});

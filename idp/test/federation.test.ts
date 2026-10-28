// SPDX-License-Identifier: AGPL-3.0-only
// Accounts of people signed in at identity providers (the protocols are
// covered by e2e/federation.spec.ts).
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UserStore } from '../src/accounts/users.ts';
import { oidcConfigSchema } from '../src/federation/config.ts';
import { signInFederated, type FederatedPerson } from '../src/federation/people.ts';
import { ProviderStore, type Provider } from '../src/federation/store.ts';
import { hasTestDatabase, openTestDatabase, resetTestDatabase } from './helpers/db.ts';

describe.skipIf(!hasTestDatabase)('signing in at identity providers (database)', () => {
  let pool: pg.Pool;
  let users: UserStore;
  let providers: ProviderStore;

  beforeAll(async () => {
    pool = await openTestDatabase();
    users = new UserStore(pool);
    providers = new ProviderStore(pool, randomBytes(32));
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetTestDatabase(pool);
  });

  const provider = (config: Partial<ReturnType<typeof oidcConfigSchema.parse>> = {}) =>
    providers.create({
      kind: 'oidc',
      name: 'Entra ID',
      enabled: true,
      secret: 'client-secret',
      config: oidcConfigSchema.parse({
        issuer: 'https://login.example.com',
        clientId: 'cenacle',
        adminGroups: ['admins'],
        guestGroups: ['partners'],
        ...config,
      }),
    });
  const ada: FederatedPerson = {
    externalId: 'sub-ada',
    displayName: 'Ada',
    email: 'ada@example.com',
    emailVerified: true,
    groups: ['engineering', 'admins'],
  };

  it('creates the account at the first sign-in and keeps it in step', async () => {
    const p = await provider();
    const first = await signInFederated(pool, p, ada);
    expect('userId' in first).toBe(true);
    const id = (first as { userId: string }).userId;
    let user = (await users.findById(id))!;
    expect(user).toMatchObject({
      email: 'ada@example.com',
      directoryRole: 'admin',
      fromProvider: true,
      fromDirectory: false,
    });
    expect(await users.groups(id)).toEqual(['admins', 'engineering']);

    const again = await signInFederated(pool, p, {
      ...ada,
      displayName: 'Ada L.',
      groups: ['partners'],
    });
    expect(again).toEqual({ userId: id });
    user = (await users.findById(id))!;
    expect(user).toMatchObject({ displayName: 'Ada L.', directoryRole: 'guest' });
    expect(await users.groups(id)).toEqual(['partners']);
  });

  it('takes over a local account by verified address only when asked to', async () => {
    const local = await users.create({
      email: 'ada@example.com',
      displayName: 'Ada (local)',
      password: 'correct horse battery staple',
    });
    const separate = (await signInFederated(pool, await provider(), ada)) as { userId: string };
    expect(separate.userId).not.toBe(local.id);
    // The address stays with the local account.
    expect((await users.findById(separate.userId))!.email).toBeNull();

    await resetTestDatabase(pool);
    const local2 = await users.create({
      email: 'ada@example.com',
      displayName: 'Ada (local)',
      password: 'correct horse battery staple',
    });
    const linking = await provider({ linkByEmail: true });
    // An address the provider does not vouch for links nothing.
    const unverified = (await signInFederated(pool, linking, {
      ...ada,
      externalId: 'sub-x',
      emailVerified: false,
    })) as { userId: string };
    expect(unverified.userId).not.toBe(local2.id);
    expect(await signInFederated(pool, linking, ada)).toEqual({ userId: local2.id });
    expect((await users.findById(local2.id))!.fromProvider).toBe(true);
  });

  it('never takes over an administrator or an account with a second step', async () => {
    for (const column of ['is_admin = true', 'totp_enabled_at = now()']) {
      await resetTestDatabase(pool);
      const p = await provider({ linkByEmail: true });
      const local = await users.create({
        email: 'ada@example.com',
        displayName: 'Ada (local)',
        password: 'correct horse battery staple',
      });
      await pool.query(`UPDATE users SET ${column} WHERE id = $1`, [local.id]);
      const signedIn = (await signInFederated(pool, p, ada)) as { userId: string };
      expect(signedIn.userId).not.toBe(local.id);
      const kept = (await users.findById(local.id))!;
      expect(kept).toMatchObject({ fromProvider: false, email: 'ada@example.com' });
    }
  });

  it('does not revive accounts an administrator disabled', async () => {
    const p: Provider = await provider();
    const { userId } = (await signInFederated(pool, p, ada)) as { userId: string };
    expect(await users.setDisabledById(userId, true)).toBe(true);
    expect(await signInFederated(pool, p, ada)).toEqual({ error: 'disabled' });
    expect((await users.findById(userId))!.disabled).toBe(true);
  });

  it('keeps sign-ins on their way bound to their browser and place', async () => {
    const p = await provider();
    const { request, binding } = await providers.begin(p.id, 'login', 'uid-1');
    expect(await providers.pending(p.id, request.state)).toMatchObject({ interaction: 'uid-1' });
    const { userId } = (await signInFederated(pool, p, ada)) as { userId: string };
    expect(await providers.answer(request.state, userId)).toBe(true);
    // Answered once; no longer pending.
    expect(await providers.answer(request.state, userId)).toBe(false);
    expect(await providers.pending(p.id, request.state)).toBeNull();
    // Another browser, another interaction or the account pages: nothing.
    expect(await providers.finish(request.state, 'other', 'login', 'uid-1')).toBeNull();
    expect(await providers.finish(request.state, binding, 'login', 'uid-2')).toBeNull();
    expect(await providers.finish(request.state, binding, 'account', null)).toBeNull();
    expect(await providers.finish(request.state, binding, 'login', 'uid-1')).toBe(userId);
    expect(await providers.finish(request.state, binding, 'login', 'uid-1')).toBeNull();
  });

  it('keeps the client secret encrypted', async () => {
    const p = await provider();
    expect(await providers.secret(p.id)).toBe('client-secret');
    const { rows } = await pool.query('SELECT secret_enc, config FROM identity_sources');
    expect(String(rows[0].secret_enc)).not.toContain('client-secret');
    expect(JSON.stringify(rows[0].config)).not.toContain('client-secret');
  });
});

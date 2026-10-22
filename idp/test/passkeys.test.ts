// SPDX-License-Identifier: AGPL-3.0-only
//
// Passkey challenges and options. Real authenticator answers are covered by
// e2e/passkeys.spec.ts (Chromium's virtual authenticator).
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PasskeyStore } from '../src/accounts/passkeys.ts';
import { UserStore } from '../src/accounts/users.ts';
import { hasTestDatabase, openTestDatabase, resetTestDatabase } from './helpers/db.ts';

describe.skipIf(!hasTestDatabase)('PasskeyStore (database)', () => {
  let pool: pg.Pool;
  let passkeys: PasskeyStore;
  let users: UserStore;

  beforeAll(async () => {
    pool = await openTestDatabase();
    passkeys = new PasskeyStore(pool, 'https://id.example.com');
    users = new UserStore(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetTestDatabase(pool);
  });

  const someone = (email: string) =>
    users.create({ email, displayName: email, password: 'correct horse battery staple' });

  it('is the relying party of its own host', () => {
    expect(passkeys.rpID).toBe('id.example.com');
    expect(passkeys.origin).toBe('https://id.example.com');
  });

  it('asks for a discoverable passkey with user verification', async () => {
    const user = await someone('ayse@example.com');
    const { options } = await passkeys.registrationOptions(user);
    expect(options.rp).toEqual({ name: 'Cenacle ID', id: 'id.example.com' });
    expect(options.authenticatorSelection).toMatchObject({
      residentKey: 'required',
      userVerification: 'required',
    });
    expect(options.attestation).toBe('none');
    const signIn = await passkeys.authenticationOptions('login', 'uid-1');
    expect(signIn.options.userVerification).toBe('required');
    expect(signIn.options.allowCredentials ?? []).toEqual([]);
  });

  it('takes a challenge once, for its purpose, interaction and account', async () => {
    const ayse = await someone('ayse@example.com');
    const mert = await someone('mert@example.com');
    const bogus = { id: 'x', rawId: 'x', type: 'public-key', response: {} };

    // A registration challenge is the account's own.
    const reg = await passkeys.registrationOptions(ayse);
    expect(
      await passkeys.register(mert.id, reg.challengeId, bogus as RegistrationResponseJSON, 'Key'),
    ).toBe('expired');
    // ...and it was spent by that attempt.
    expect(
      await passkeys.register(ayse.id, reg.challengeId, bogus as RegistrationResponseJSON, 'Key'),
    ).toBe('expired');

    const login = await passkeys.authenticationOptions('login', 'uid-1');
    const assertion = bogus as AuthenticationResponseJSON;
    // Another purpose does not find it; another interaction spends it.
    expect(await passkeys.authenticate('account', login.challengeId, assertion)).toBeNull();
    expect(await passkeys.authenticate('login', login.challengeId, assertion, 'uid-2')).toBeNull();
    expect(await passkeys.authenticate('login', login.challengeId, assertion, 'uid-1')).toBeNull();
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM webauthn_challenges');
    expect(rows[0].n).toBe(0);
  });

  it('removes only the account’s own passkeys', async () => {
    const ayse = await someone('ayse@example.com');
    const mert = await someone('mert@example.com');
    await pool.query(
      `INSERT INTO passkeys (id, user_id, public_key, device_type, name)
       VALUES ('cred-1', $1, '\\x00', 'multiDevice', 'Phone')`,
      [ayse.id],
    );
    expect(await passkeys.remove(mert.id, 'cred-1')).toBe(false);
    expect((await passkeys.list(ayse.id)).map((p) => [p.name, p.synced])).toEqual([
      ['Phone', true],
    ]);
    expect(await passkeys.remove(ayse.id, 'cred-1')).toBe(true);
    expect(await passkeys.any(ayse.id)).toBe(false);
  });
});

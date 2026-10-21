// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from 'node:crypto';
import { generate } from 'otplib';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CHALLENGE_ATTEMPTS, MfaStore } from '../src/accounts/mfa.ts';
import { UserStore } from '../src/accounts/users.ts';
import { signAccount, verifyAccount } from '../src/account/session.ts';
import { hasTestDatabase, openTestDatabase, resetTestDatabase } from './helpers/db.ts';

describe('account cookie', () => {
  const keys = ['new-key-0123456789abcdefghijklmnop', 'old-key-0123456789abcdefghijklmnop'];
  it('names the user until it expires and checks the signature with every key', () => {
    const now = Date.UTC(2026, 9, 21, 12);
    const value = signAccount(keys, 'u1', now);
    expect(verifyAccount(keys, value, now + 60_000)).toBe('u1');
    expect(verifyAccount(keys.slice(1), signAccount(keys.slice(1), 'u1', now), now)).toBe('u1');
    expect(verifyAccount(['another-key-0123456789abcdefghijk'], value, now)).toBeNull();
    expect(verifyAccount(keys, value.replace('u1', 'u2'), now)).toBeNull();
    expect(verifyAccount(keys, value, now + 31 * 60_000)).toBeNull();
    expect(verifyAccount(keys, undefined, now)).toBeNull();
  });
});

describe.skipIf(!hasTestDatabase)('MfaStore (database)', () => {
  let pool: pg.Pool;
  let mfa: MfaStore;
  let userId: string;

  beforeAll(async () => {
    pool = await openTestDatabase();
    mfa = new MfaStore(pool, randomBytes(32));
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetTestDatabase(pool);
    const u = await new UserStore(pool).create({
      email: 'ayse@example.com',
      displayName: 'Ayşe',
      password: 'correct horse battery staple',
    });
    userId = u.id;
  });

  it('turns on with a code, accepts each code once and recovery codes once', async () => {
    const { secret, uri } = await mfa.beginSetup(userId, 'ayse@example.com');
    expect(uri).toMatch(/^otpauth:\/\/totp\/Cenacle%20ID:ayse%40example\.com\?/);
    // The secret is stored encrypted.
    const { rows } = await pool.query('SELECT totp_secret_enc FROM users');
    expect(rows[0].totp_secret_enc.toString()).not.toContain(secret);

    expect(await mfa.confirmSetup(userId, '000000')).toBeNull();
    const code = await generate({ secret });
    const codes = (await mfa.confirmSetup(userId, code))!;
    expect(codes).toHaveLength(10);
    expect(await mfa.enabled(userId)).toBe(true);

    // The code that confirmed the setup cannot be used again.
    expect(await mfa.verify(userId, code)).toBeNull();
    expect(await mfa.verify(userId, codes[0]!.toUpperCase())).toBe('recovery');
    expect(await mfa.verify(userId, codes[0]!)).toBeNull();
    expect(await mfa.remainingRecoveryCodes(userId)).toBe(9);

    const fresh = await mfa.regenerateRecoveryCodes(userId);
    expect(await mfa.verify(userId, codes[1]!)).toBeNull();
    expect(await mfa.verify(userId, fresh[1]!)).toBe('recovery');

    await mfa.disable(userId);
    expect(await mfa.enabled(userId)).toBe(false);
    expect(await mfa.remainingRecoveryCodes(userId)).toBe(0);
  });

  it('challenges expire after a few wrong attempts', async () => {
    const id = await mfa.createChallenge(userId, 'account');
    expect((await mfa.challenge(id, 'account'))?.attemptsLeft).toBe(CHALLENGE_ATTEMPTS);
    expect(await mfa.challenge(id, 'login')).toBeNull();
    for (let i = CHALLENGE_ATTEMPTS - 1; i >= 0; i--) expect(await mfa.failAttempt(id)).toBe(i);
    expect(await mfa.challenge(id, 'account')).toBeNull();
  });
});

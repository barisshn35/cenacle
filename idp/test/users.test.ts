// SPDX-License-Identifier: Apache-2.0
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkPasswordPolicy } from '../src/accounts/passwords.ts';
import { UserError, UserStore } from '../src/accounts/users.ts';
import { hasTestDatabase, openTestDatabase, resetTestDatabase } from './helpers/db.ts';

const PASSWORD = 'correct horse battery staple';

describe('password policy (NIST SP 800-63B-4)', () => {
  it('requires 15 characters and allows long passphrases and any characters', () => {
    expect(checkPasswordPolicy('short-password')).toBe('too_short');
    expect(checkPasswordPolicy('çok uzun bir parola cümlesi')).toBeNull();
    expect(checkPasswordPolicy('🔑'.repeat(15))).toBeNull();
    expect(checkPasswordPolicy('x'.repeat(257))).toBe('too_long');
  });
});

describe.skipIf(!hasTestDatabase)('UserStore (database)', () => {
  let pool: pg.Pool;
  let users: UserStore;

  beforeAll(async () => {
    pool = await openTestDatabase();
    users = new UserStore(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetTestDatabase(pool);
  });

  it('creates users with uuidv7 ids and Argon2id hashes', async () => {
    const u = await users.create({
      email: 'Ayse@Example.com',
      displayName: 'Ayşe',
      password: PASSWORD,
    });
    expect(u.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    const { rows } = await pool.query('SELECT password_hash FROM users');
    expect(rows[0].password_hash).toMatch(/^\$argon2id\$/);
  });

  it('treats e-mail addresses case-insensitively and uniquely', async () => {
    await users.create({ email: 'ayse@example.com', displayName: 'Ayşe', password: PASSWORD });
    await expect(
      users.create({ email: 'AYSE@example.com', displayName: 'Other', password: PASSWORD }),
    ).rejects.toEqual(new UserError('email_taken'));
    expect(await users.authenticate('AYSE@EXAMPLE.COM', PASSWORD)).not.toBeNull();
  });

  it('rejects weak passwords and invalid input', async () => {
    await expect(
      users.create({ email: 'a@example.com', displayName: 'A', password: 'short' }),
    ).rejects.toEqual(new UserError('too_short'));
    await expect(
      users.create({ email: 'not-an-email', displayName: 'A', password: PASSWORD }),
    ).rejects.toEqual(new UserError('invalid_email'));
  });

  it('authenticates only valid, enabled accounts', async () => {
    const u = await users.create({ email: 'a@example.com', displayName: 'A', password: PASSWORD });
    expect((await users.authenticate('a@example.com', PASSWORD))?.id).toBe(u.id);
    expect(await users.authenticate('a@example.com', 'wrong password, long enough')).toBeNull();
    expect(await users.authenticate('missing@example.com', PASSWORD)).toBeNull();

    await users.setDisabled('a@example.com', true);
    expect(await users.authenticate('a@example.com', PASSWORD)).toBeNull();
    await users.setDisabled('a@example.com', false);
    await users.setPassword('a@example.com', 'a brand new passphrase');
    expect(await users.authenticate('a@example.com', 'a brand new passphrase')).not.toBeNull();
  });

  it('spends similar time on unknown accounts and wrong passwords', async () => {
    await users.create({ email: 'a@example.com', displayName: 'A', password: PASSWORD });
    const time = async (email: string) => {
      const start = performance.now();
      await users.authenticate(email, 'some wrong passphrase!!');
      return performance.now() - start;
    };
    await time('warmup@example.com');
    const known = await time('a@example.com');
    const unknown = await time('nobody@example.com');
    expect(Math.abs(known - unknown)).toBeLessThan(Math.max(known, unknown) * 0.6);
  });

  it('finds by id and ignores malformed ids', async () => {
    const u = await users.create({ email: 'a@example.com', displayName: 'A', password: PASSWORD });
    expect((await users.findById(u.id))?.email).toBe('a@example.com');
    expect(await users.findById("1' OR '1'='1")).toBeNull();
  });
});

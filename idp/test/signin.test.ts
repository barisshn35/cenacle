// SPDX-License-Identifier: AGPL-3.0-only
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/accounts/audit.ts';
import { checkPassword, PASSWORD_FAILURES } from '../src/accounts/signin.ts';
import { UserStore } from '../src/accounts/users.ts';
import { hasTestDatabase, openTestDatabase, resetTestDatabase } from './helpers/db.ts';

const PASSWORD = 'correct horse battery staple';

describe.skipIf(!hasTestDatabase)('password sign-in limit per account (database)', () => {
  let pool: pg.Pool;
  let users: UserStore;
  let audit: AuditLog;

  beforeAll(async () => {
    pool = await openTestDatabase();
    users = new UserStore(pool);
    audit = new AuditLog(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetTestDatabase(pool);
  });

  // What the sign-in routes do with a result.
  const attempt = async (identifier: string, password: string) => {
    const result = await checkPassword(users, undefined, identifier, password);
    if ('error' in result) {
      await audit.record(
        'signin.failed',
        'userId' in result ? (result.userId ?? null) : null,
        '::1',
      );
    }
    return result;
  };

  it('stops checking passwords of an account after too many failures', async () => {
    const user = await users.create({
      email: 'ada@example.com',
      displayName: 'Ada',
      password: PASSWORD,
    });
    for (let i = 0; i < PASSWORD_FAILURES - 1; i++) {
      expect(await attempt('ADA@example.com', `wrong passphrase number ${i}`)).toEqual({
        error: 'invalid',
        userId: user.id,
      });
    }
    // One failure left: the right password still works.
    expect('user' in (await attempt('ada@example.com', PASSWORD))).toBe(true);
    await attempt('ada@example.com', 'one more wrong passphrase');
    // Now even the right password answers like a wrong one.
    expect(await attempt('ada@example.com', PASSWORD)).toEqual({
      error: 'invalid',
      userId: user.id,
    });
    // Older failures fall out of the window.
    await pool.query(`UPDATE signin_attempts SET at = now() - interval '16 minutes'`);
    expect('user' in (await attempt('ada@example.com', PASSWORD))).toBe(true);
  });

  it('checks no more passwords than the limit when they arrive together', async () => {
    await users.create({ email: 'ada@example.com', displayName: 'Ada', password: PASSWORD });
    let checked = 0;
    const authenticate = users.authenticate.bind(users);
    users.authenticate = async (...args) => {
      checked++;
      return authenticate(...args);
    };
    try {
      await Promise.all(
        Array.from({ length: PASSWORD_FAILURES * 2 }, (_, i) =>
          attempt('ada@example.com', `wrong passphrase number ${i}`),
        ),
      );
    } finally {
      users.authenticate = authenticate;
    }
    expect(checked).toBe(PASSWORD_FAILURES);
    expect(await attempt('ada@example.com', PASSWORD)).toMatchObject({ error: 'invalid' });
  });

  it('answers an unknown account the same way, without locking anything', async () => {
    for (let i = 0; i < PASSWORD_FAILURES + 1; i++) {
      expect(await attempt('nobody@example.com', `wrong passphrase number ${i}`)).toEqual({
        error: 'invalid',
      });
    }
    // Failures for unknown accounts are not counted against a later account.
    await users.create({ email: 'nobody@example.com', displayName: 'N', password: PASSWORD });
    expect('user' in (await attempt('nobody@example.com', PASSWORD))).toBe(true);
  });
});

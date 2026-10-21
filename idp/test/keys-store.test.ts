// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KeyStore } from '../src/keys/store.ts';
import { hasTestDatabase, openTestDatabase, resetTestDatabase } from './helpers/db.ts';

describe.skipIf(!hasTestDatabase)('KeyStore (database)', () => {
  let pool: pg.Pool;
  let store: KeyStore;
  const kek = randomBytes(32);

  beforeAll(async () => {
    pool = await openTestDatabase();
    store = new KeyStore(pool, kek);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetTestDatabase(pool);
  });

  it('creates exactly one active key, also under concurrency', async () => {
    const results = await Promise.all([store.ensureActiveKey(), store.ensureActiveKey()]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.kid)).size).toBe(1);
    expect(await store.list()).toHaveLength(1);
  });

  it('never stores the private key in clear text', async () => {
    await store.ensureActiveKey();
    const { rows } = await pool.query(
      `SELECT public_jwk, encode(private_jwk_enc, 'escape') AS enc FROM signing_keys`,
    );
    expect(rows[0].public_jwk.d).toBeUndefined();
    expect(rows[0].enc).not.toContain('"d"');
  });

  it('rotates and keeps the previous key published for the grace period', async () => {
    const first = await store.ensureActiveKey();
    const rotated = await store.rotate();
    expect(rotated.retired).toBe(first.kid);

    const keys = await store.loadSigningKeys(3600);
    expect(keys.map((k) => k.kid)).toEqual([rotated.kid, first.kid]);
    expect(keys[0]).toMatchObject({ alg: 'RS256', use: 'sig', kty: 'RSA' });
    expect(keys[0]!.d).toBeDefined();

    const list = await store.list();
    expect(list.map((k) => k.state)).toEqual(['active', 'retired']);
  });

  it('prunes retired keys after the grace period', async () => {
    const first = await store.ensureActiveKey();
    await store.rotate();
    await pool.query(
      `UPDATE signing_keys SET retired_at = now() - interval '8 days' WHERE kid = $1`,
      [first.kid],
    );
    expect(await store.loadSigningKeys(7 * 86400)).toHaveLength(1);
    expect(await store.prune(7 * 86400)).toEqual([first.kid]);
    expect(await store.list()).toHaveLength(1);
  });

  it('refuses keys sealed with another encryption key', async () => {
    await store.ensureActiveKey();
    await expect(new KeyStore(pool, randomBytes(32)).loadSigningKeys(3600)).rejects.toThrow();
  });
});

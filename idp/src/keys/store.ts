// SPDX-License-Identifier: AGPL-3.0-only
import { calculateJwkThumbprint, exportJWK, generateKeyPair, type JWK } from 'jose';
import type pg from 'pg';
import { openPrivateKey, sealPrivateKey } from './crypto.ts';

/** ID tokens are signed with RS256, which every OpenID Provider must support. */
export const SIGNING_ALG = 'RS256';
const MODULUS_LENGTH = 3072;
// Any value works; it only has to be the same for every IdP replica.
const KEYS_LOCK_ID = 0x6365_6e61_6b79; // "cenaky"

export interface SigningKeyInfo {
  kid: string;
  alg: string;
  state: 'active' | 'retired';
  createdAt: Date;
  retiredAt: Date | null;
}

/**
 * Token signing keys, stored encrypted in the IdP database.
 *
 * Rotation keeps the previous key published (state "retired") for a grace
 * period so tokens it signed still verify; prune removes keys whose grace
 * period has ended. Changes take effect when the IdP (re)starts.
 */
export class KeyStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly kek: Buffer,
  ) {}

  private async createKey(client: pg.PoolClient): Promise<string> {
    const { privateKey } = await generateKeyPair(SIGNING_ALG, {
      modulusLength: MODULUS_LENGTH,
      extractable: true,
    });
    const priv = await exportJWK(privateKey);
    const kid = await calculateJwkThumbprint(priv, 'sha256');
    const { d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, ...pub } = priv;
    const privateJwk: JWK = { ...priv, kid, alg: SIGNING_ALG, use: 'sig' };
    const publicJwk: JWK = { ...pub, kid, alg: SIGNING_ALG, use: 'sig' };
    await client.query(
      `INSERT INTO signing_keys (kid, alg, public_jwk, private_jwk_enc, state)
       VALUES ($1, $2, $3, $4, 'active')`,
      [kid, SIGNING_ALG, publicJwk, sealPrivateKey(this.kek, kid, JSON.stringify(privateJwk))],
    );
    return kid;
  }

  private async withLock<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [KEYS_LOCK_ID]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Creates the first signing key if none is active (safe with several replicas). */
  async ensureActiveKey(): Promise<{ kid: string; created: boolean }> {
    return this.withLock(async (client) => {
      const { rows } = await client.query<{ kid: string }>(
        `SELECT kid FROM signing_keys WHERE alg = $1 AND state = 'active'`,
        [SIGNING_ALG],
      );
      if (rows[0]) return { kid: rows[0].kid, created: false };
      return { kid: await this.createKey(client), created: true };
    });
  }

  /** Makes a new key active and keeps the previous one published as retired. */
  async rotate(): Promise<{ kid: string; retired: string | null }> {
    return this.withLock(async (client) => {
      const { rows } = await client.query<{ kid: string }>(
        `UPDATE signing_keys SET state = 'retired', retired_at = now()
         WHERE alg = $1 AND state = 'active' RETURNING kid`,
        [SIGNING_ALG],
      );
      const kid = await this.createKey(client);
      return { kid, retired: rows[0]?.kid ?? null };
    });
  }

  /** Deletes retired keys older than the grace period. Returns the removed key ids. */
  async prune(graceSeconds: number): Promise<string[]> {
    const { rows } = await this.pool.query<{ kid: string }>(
      `DELETE FROM signing_keys
       WHERE state = 'retired' AND retired_at < now() - make_interval(secs => $1)
       RETURNING kid`,
      [graceSeconds],
    );
    return rows.map((r) => r.kid);
  }

  async list(): Promise<SigningKeyInfo[]> {
    const { rows } = await this.pool.query(
      `SELECT kid, alg, state, created_at, retired_at FROM signing_keys
       ORDER BY state = 'active' DESC, created_at DESC`,
    );
    return rows.map((r) => ({
      kid: r.kid,
      alg: r.alg,
      state: r.state,
      createdAt: r.created_at,
      retiredAt: r.retired_at,
    }));
  }

  /**
   * Private JWKs for the provider: the active key first (used for signing),
   * then retired keys within the grace period (published for verification).
   */
  async loadSigningKeys(graceSeconds: number): Promise<JWK[]> {
    const { rows } = await this.pool.query<{ kid: string; private_jwk_enc: Buffer }>(
      `SELECT kid, private_jwk_enc FROM signing_keys
       WHERE state = 'active'
          OR (state = 'retired' AND retired_at >= now() - make_interval(secs => $1))
       ORDER BY state = 'active' DESC, created_at DESC`,
      [graceSeconds],
    );
    return rows.map((r) => JSON.parse(openPrivateKey(this.kek, r.kid, r.private_jwk_enc)) as JWK);
  }
}

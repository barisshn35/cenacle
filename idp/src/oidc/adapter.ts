// SPDX-License-Identifier: Apache-2.0
import type pg from 'pg';

// Models whose artifacts belong to a grant and are revoked together.
const GRANTABLE = new Set([
  'AccessToken',
  'AuthorizationCode',
  'RefreshToken',
  'DeviceCode',
  'BackchannelAuthenticationRequest',
]);

type Payload = Record<string, unknown> & {
  grantId?: string;
  userCode?: string;
  uid?: string;
  consumed?: number;
};

/**
 * oidc-provider storage adapter on PostgreSQL: one table for every model.
 * Expired rows are ignored on read and deleted by pruneExpired().
 */
export function createPostgresAdapter(pool: pg.Pool) {
  return class PostgresAdapter {
    constructor(private readonly model: string) {}

    async upsert(id: string, payload: Payload, expiresIn?: number): Promise<void> {
      await pool.query(
        `INSERT INTO oidc_payloads (model, id, payload, grant_id, user_code, uid, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6,
                 CASE WHEN $7::int IS NULL THEN NULL ELSE now() + make_interval(secs => $7) END)
         ON CONFLICT (model, id) DO UPDATE SET
           payload = EXCLUDED.payload, grant_id = EXCLUDED.grant_id,
           user_code = EXCLUDED.user_code, uid = EXCLUDED.uid, expires_at = EXCLUDED.expires_at`,
        [
          this.model,
          id,
          payload,
          GRANTABLE.has(this.model) ? (payload.grantId ?? null) : null,
          payload.userCode ?? null,
          payload.uid ?? null,
          expiresIn ?? null,
        ],
      );
    }

    private async findWhere(column: 'id' | 'uid' | 'user_code', value: string) {
      const { rows } = await pool.query<{ payload: Payload; consumed_at: Date | null }>(
        `SELECT payload, consumed_at FROM oidc_payloads
         WHERE model = $1 AND ${column} = $2 AND (expires_at IS NULL OR expires_at > now())`,
        [this.model, value],
      );
      const row = rows[0];
      if (!row) return undefined;
      return row.consumed_at
        ? { ...row.payload, consumed: Math.floor(row.consumed_at.getTime() / 1000) }
        : row.payload;
    }

    find(id: string) {
      return this.findWhere('id', id);
    }

    findByUid(uid: string) {
      return this.findWhere('uid', uid);
    }

    findByUserCode(userCode: string) {
      return this.findWhere('user_code', userCode);
    }

    async consume(id: string): Promise<void> {
      await pool.query(
        `UPDATE oidc_payloads SET consumed_at = now() WHERE model = $1 AND id = $2`,
        [this.model, id],
      );
    }

    async destroy(id: string): Promise<void> {
      await pool.query(`DELETE FROM oidc_payloads WHERE model = $1 AND id = $2`, [this.model, id]);
    }

    async revokeByGrantId(grantId: string): Promise<void> {
      await pool.query(`DELETE FROM oidc_payloads WHERE grant_id = $1`, [grantId]);
    }
  };
}

/** Deletes expired artifacts; returns the number of removed rows. */
export async function pruneExpired(pool: pg.Pool): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM oidc_payloads WHERE expires_at IS NOT NULL AND expires_at <= now()`,
  );
  return rowCount ?? 0;
}

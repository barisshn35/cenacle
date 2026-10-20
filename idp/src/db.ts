// SPDX-License-Identifier: Apache-2.0
import pg from 'pg';
import type { Config } from './config.ts';
import type { ReadinessCheck } from './app.ts';

/**
 * Connection pool of the IdP database (separate from the chat database).
 * pg connects lazily, so the IdP starts and reports "not ready" while the
 * database is down.
 */
export function createPool(cfg: Config['database']): pg.Pool {
  return new pg.Pool({
    connectionString: cfg.url,
    max: cfg.poolMax,
    application_name: 'cenacle-idp',
    connectionTimeoutMillis: 2000,
  });
}

export function poolCheck(pool: pg.Pool): ReadinessCheck {
  return {
    name: 'postgres',
    check: async (signal) => {
      const query = pool.query('SELECT 1');
      const aborted = new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      await Promise.race([query, aborted]);
    },
  };
}

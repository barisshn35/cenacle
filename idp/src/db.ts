// SPDX-License-Identifier: AGPL-3.0-only
import pg from 'pg';
import type { Config } from './config.ts';
import type { ReadinessCheck } from './app.ts';

/** The longest a query of the server may wait for the database. */
export const QUERY_TIMEOUT_MS = 30_000;

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
    // A database that stops answering without closing the connection (a
    // network partition) would hold a query for the system's TCP timeout,
    // minutes long: keepalives end dead idle connections, and a query gives
    // up after QUERY_TIMEOUT_MS (the request then fails instead of hanging).
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    query_timeout: QUERY_TIMEOUT_MS,
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

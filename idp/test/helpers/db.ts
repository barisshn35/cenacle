// SPDX-License-Identifier: AGPL-3.0-only
import pg from 'pg';
import { migrate } from '../../src/db/migrate.ts';

/**
 * Integration tests run against IDP_TEST_DATABASE_URL (a dedicated database:
 * every table is truncated between tests). Without it they are skipped.
 */
export const TEST_DATABASE_URL = process.env.IDP_TEST_DATABASE_URL;
export const hasTestDatabase = Boolean(TEST_DATABASE_URL);

export async function openTestDatabase(): Promise<pg.Pool> {
  if (!TEST_DATABASE_URL) throw new Error('IDP_TEST_DATABASE_URL is not set');
  await migrate({ databaseUrl: TEST_DATABASE_URL, direction: 'up' });
  return new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
}

export async function resetTestDatabase(pool: pg.Pool): Promise<void> {
  await pool.query(
    'TRUNCATE users, oidc_payloads, signing_keys, audit_events, identity_sources, webauthn_challenges CASCADE',
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
import pg from 'pg';
import { resetTestDatabase, TEST_DATABASE_URL } from './db.ts';

/**
 * After the last test file: the test database is emptied, so nothing a test
 * left behind (a directory with made-up settings, say) reaches the next user
 * of the database, such as the full-stack tests' Cenacle ID.
 */
export async function teardown(): Promise<void> {
  if (!TEST_DATABASE_URL) return;
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  try {
    await resetTestDatabase(pool);
  } finally {
    await pool.end();
  }
}

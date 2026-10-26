// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createPool, QUERY_TIMEOUT_MS } from '../src/db.ts';

describe('createPool', () => {
  it('gives up on a database that stopped answering', async () => {
    const pool = createPool({ url: 'postgres://u:p@127.0.0.1:1/x', poolMax: 1 });
    const options = (pool as unknown as { options: Record<string, unknown> }).options;
    expect(options.keepAlive).toBe(true);
    expect(options.query_timeout).toBe(QUERY_TIMEOUT_MS);
    expect(options.connectionTimeoutMillis).toBe(2000);
    await pool.end();
  });
});

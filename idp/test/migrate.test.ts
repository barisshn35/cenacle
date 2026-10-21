// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.ts';
import { hasTestDatabase, TEST_DATABASE_URL } from './helpers/db.ts';

describe.skipIf(!hasTestDatabase)('migrations (database)', () => {
  it('lets replicas that start together wait for each other', async () => {
    const run = () => migrate({ databaseUrl: TEST_DATABASE_URL!, direction: 'up' });
    await expect(Promise.all([run(), run(), run()])).resolves.toHaveLength(3);
  });
});

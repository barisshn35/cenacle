// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';

/** SQL migrations ship with the IdP and run under node-pg-migrate's advisory lock. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

export type Direction = 'up' | 'down';

export interface MigrateOptions {
  databaseUrl: string;
  direction: Direction;
  /** Number of migrations; default: all for "up", one for "down". */
  count?: number;
  log?: (msg: string) => void;
}

export async function migrate({ databaseUrl, direction, count, log }: MigrateOptions) {
  return runner({
    databaseUrl,
    dir: MIGRATIONS_DIR,
    direction,
    count: count ?? (direction === 'up' ? Infinity : 1),
    migrationsTable: 'idp_migrations',
    singleTransaction: true,
    // Replicas that start together wait for the lock instead of failing.
    advisoryLockMode: 'wait',
    checkOrder: true,
    log: log ?? (() => {}),
  });
}

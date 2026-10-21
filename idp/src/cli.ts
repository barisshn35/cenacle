// SPDX-License-Identifier: Apache-2.0
//
// Maintenance commands of Cenacle ID:
//   cenacle-idp migrate up|down
// More commands (keys, users) are registered below as they are added.

import { ConfigError, loadDatabaseConfig, loadKeyConfig } from './config.ts';
import { createPool } from './db.ts';
import { migrate } from './db/migrate.ts';
import { KeyStore } from './keys/store.ts';

const USAGE = `usage: cenacle-idp <command>

commands:
  migrate up            apply all pending migrations
  migrate down          roll back the latest migration
  keys list             list token signing keys
  keys rotate           create a new active signing key (restart Cenacle ID afterwards)
  keys prune            delete retired keys older than the grace period`;

export class UsageError extends Error {}

async function runMigrate(args: string[]): Promise<void> {
  const direction = args[0];
  if (direction !== 'up' && direction !== 'down') throw new UsageError(USAGE);
  const db = loadDatabaseConfig();
  const applied = await migrate({ databaseUrl: db.url, direction, log: () => {} });
  if (applied.length === 0) {
    console.log(direction === 'up' ? 'no pending migrations' : 'nothing to roll back');
  }
  for (const m of applied) console.log(`migration ${direction}: ${m.name}`);
}

async function runKeys(args: string[]): Promise<void> {
  const action = args[0];
  if (action !== 'list' && action !== 'rotate' && action !== 'prune') throw new UsageError(USAGE);
  const cfg = loadKeyConfig();
  const pool = createPool(cfg.database);
  try {
    const store = new KeyStore(pool, cfg.keyEncryptionKey);
    if (action === 'rotate') {
      const { kid, retired } = await store.rotate();
      console.log(`active key: ${kid}`);
      if (retired) console.log(`retired key: ${retired} (published for the grace period)`);
      console.log('restart Cenacle ID to start signing with the new key');
    } else if (action === 'prune') {
      const removed = await store.prune(cfg.retiredKeyGraceSeconds);
      console.log(removed.length ? `removed: ${removed.join(', ')}` : 'nothing to remove');
    } else {
      for (const k of await store.list()) {
        const retired = k.retiredAt ? ` retired ${k.retiredAt.toISOString()}` : '';
        console.log(
          `${k.state.padEnd(7)} ${k.alg} ${k.kid} created ${k.createdAt.toISOString()}${retired}`,
        );
      }
    }
  } finally {
    await pool.end();
  }
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'migrate':
        await runMigrate(rest);
        return 0;
      case 'keys':
        await runKeys(rest);
        return 0;
      default:
        throw new UsageError(USAGE);
    }
  } catch (err) {
    if (err instanceof UsageError || err instanceof ConfigError) {
      console.error(err.message);
      return 2;
    }
    console.error(err);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2));
}

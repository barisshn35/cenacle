// SPDX-License-Identifier: Apache-2.0
//
// Maintenance commands of Cenacle ID:
//   cenacle-idp migrate up|down
// More commands (keys, users) are registered below as they are added.

import { ConfigError, loadDatabaseConfig } from './config.ts';
import { migrate } from './db/migrate.ts';

const USAGE = `usage: cenacle-idp <command>

commands:
  migrate up            apply all pending migrations
  migrate down          roll back the latest migration`;

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

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'migrate':
        await runMigrate(rest);
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

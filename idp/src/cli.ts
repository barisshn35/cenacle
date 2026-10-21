// SPDX-License-Identifier: Apache-2.0
//
// Maintenance commands of Cenacle ID:
//   cenacle-idp migrate up|down
// More commands (keys, users) are registered below as they are added.

import { ConfigError, loadDatabaseConfig, loadKeyConfig } from './config.ts';
import { createPool } from './db.ts';
import { migrate } from './db/migrate.ts';
import { KeyStore } from './keys/store.ts';
import { UserError, UserStore } from './accounts/users.ts';
import { PASSWORD_MIN_LENGTH } from './accounts/passwords.ts';
import { readSecret } from './prompt.ts';

const USAGE = `usage: cenacle-idp <command>

commands:
  migrate up            apply all pending migrations
  migrate down          roll back the latest migration
  keys list             list token signing keys
  keys rotate           create a new active signing key (restart Cenacle ID afterwards)
  keys prune            delete retired keys older than the grace period
  users create --email <e> --name <n> [--verified]
                        create an account; the password is read from stdin
  users set-password --email <e>
                        set a new password (read from stdin)
  users disable|enable --email <e>
                        block or allow sign-in for an account`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function readNewPassword(): Promise<string> {
  const password = await readSecret(`New password (at least ${PASSWORD_MIN_LENGTH} characters): `);
  if (process.stdin.isTTY && (await readSecret('Repeat password: ')) !== password) {
    throw new UsageError('passwords do not match');
  }
  return password;
}

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

async function runUsers(args: string[]): Promise<void> {
  const action = args[0];
  const email = flag(args, '--email');
  if (!email) throw new UsageError(USAGE);
  const db = loadDatabaseConfig();
  const pool = createPool(db);
  const users = new UserStore(pool);
  try {
    switch (action) {
      case 'create': {
        const name = flag(args, '--name');
        if (!name) throw new UsageError(USAGE);
        const user = await users.create({
          email,
          displayName: name,
          password: await readNewPassword(),
          emailVerified: args.includes('--verified'),
        });
        console.log(`created ${user.email} (${user.id})`);
        return;
      }
      case 'set-password':
        await users.setPassword(email, await readNewPassword());
        console.log(`password updated for ${email}`);
        return;
      case 'disable':
      case 'enable':
        await users.setDisabled(email, action === 'disable');
        console.log(`${email} ${action}d`);
        return;
      default:
        throw new UsageError(USAGE);
    }
  } catch (err) {
    if (err instanceof UserError) throw new UsageError(`cannot ${action} ${email}: ${err.code}`);
    throw err;
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
      case 'users':
        await runUsers(rest);
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

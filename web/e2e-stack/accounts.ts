// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { idpEnv } from '../playwright.stack.config';

export const PASSWORD = 'e2e stack password 2026';

/** Creates an account at Cenacle ID with its CLI (or resets its password). */
export function ensureAccount(email: string, name: string): void {
  const run = (args: string[]) =>
    execFileSync('pnpm', ['exec', 'tsx', 'src/cli.ts', ...args], {
      cwd: '../idp',
      env: { ...process.env, ...idpEnv },
      input: `${PASSWORD}\n`,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  try {
    run(['users', 'create', '--email', email, '--name', name, '--verified']);
  } catch {
    run(['users', 'set-password', '--email', email]);
  }
}

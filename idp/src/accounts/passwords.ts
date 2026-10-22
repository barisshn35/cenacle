// SPDX-License-Identifier: AGPL-3.0-only
import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id with OWASP's recommended parameters (19 MiB, 2 iterations,
 * parallelism 1). Parameters are stored in each hash, so they can be raised
 * later without invalidating existing passwords.
 */
const ARGON2ID = 2; // Algorithm.Argon2id (a const enum, not importable as a value)
const OPTIONS = { algorithm: ARGON2ID, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

/**
 * NIST SP 800-63B-4: at least 15 characters while a password is the only
 * factor; no composition rules; long passphrases allowed.
 */
export const PASSWORD_MIN_LENGTH = 15;
export const PASSWORD_MAX_LENGTH = 256;

export type PasswordProblem = 'too_short' | 'too_long';

export function checkPasswordPolicy(password: string): PasswordProblem | null {
  const length = [...password.normalize('NFC')].length;
  if (length < PASSWORD_MIN_LENGTH) return 'too_short';
  if (length > PASSWORD_MAX_LENGTH) return 'too_long';
  return null;
}

export function hashPassword(password: string): Promise<string> {
  return hash(password.normalize('NFC'), OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password.normalize('NFC'));
  } catch {
    return false;
  }
}

// Verified when no account matches, so a failed sign-in takes the same time
// whether or not the e-mail address exists.
let dummyHash: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('cenacle-dummy-password-for-timing');
  await verifyPassword(await dummyHash, password);
}

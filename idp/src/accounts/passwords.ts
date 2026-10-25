// SPDX-License-Identifier: AGPL-3.0-only
import { getFips, pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { hash, verify } from '@node-rs/argon2';

const derive = promisify(pbkdf2);

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

/**
 * In FIPS mode (node --enable-fips with OpenSSL's validated provider) new
 * passwords use PBKDF2-HMAC-SHA-512 (NIST SP 800-132; OWASP: 210,000
 * iterations), an approved algorithm, instead of Argon2id:
 * "$pbkdf2-sha512$i=<iterations>$<salt>$<hash>" (base64).
 */
const PBKDF2_PREFIX = '$pbkdf2-sha512$';
const PBKDF2_ITERATIONS = 210_000;

export const fipsMode = () => getFips() === 1;

/** @internal exported for tests (FIPS mode cannot be switched in a test process). */
export async function pbkdf2Hash(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, PBKDF2_ITERATIONS, 64, 'sha512');
  return `${PBKDF2_PREFIX}i=${PBKDF2_ITERATIONS}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function pbkdf2Verify(passwordHash: string, password: string): Promise<boolean> {
  const m = /^\$pbkdf2-sha512\$i=(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(passwordHash);
  if (!m) return false;
  const iterations = Number(m[1]);
  if (iterations < 1 || iterations > 10_000_000) return false;
  const expected = Buffer.from(m[3]!, 'base64');
  const key = await derive(
    password,
    Buffer.from(m[2]!, 'base64'),
    iterations,
    expected.length,
    'sha512',
  );
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export function hashPassword(password: string): Promise<string> {
  const p = password.normalize('NFC');
  return fipsMode() ? pbkdf2Hash(p) : hash(p, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  const p = password.normalize('NFC');
  try {
    return passwordHash.startsWith(PBKDF2_PREFIX)
      ? await pbkdf2Verify(passwordHash, p)
      : await verify(passwordHash, p);
  } catch {
    return false;
  }
}

/** A hash of the other kind than this mode makes: replaced at the next sign-in. */
export const needsRehash = (passwordHash: string) =>
  passwordHash.startsWith(PBKDF2_PREFIX) !== fipsMode();

// Verified when no account matches, so a failed sign-in takes the same time
// whether or not the e-mail address exists.
let dummyHash: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('cenacle-dummy-password-for-timing');
  await verifyPassword(await dummyHash, password);
}

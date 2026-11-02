// SPDX-License-Identifier: AGPL-3.0-only
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type pg from 'pg';
import type { SourceStore } from '../directory/store.ts';
import { signInWithDirectory } from '../directory/sync.ts';
import { burnPasswordCheck } from './passwords.ts';
import type { PasskeyStore, SignInPurpose } from './passkeys.ts';
import type { User, UserStore } from './users.ts';

/** Directories people may sign in with (LDAP / Active Directory). */
export interface DirectoryAccess {
  pool: pg.Pool;
  sources: SourceStore;
}

/**
 * `userId` is the account a failed password was for, when one is known: the
 * caller records the failure with it (signin.failed) in the audit log. The
 * per-account limit counts attempts itself (attempts.ts).
 */
export type SignInResult =
  { user: User } | { error: 'invalid'; userId?: string } | { error: 'unavailable' };

/** An account allows this many failed passwords per window (on top of the per-IP limit). */
export const PASSWORD_FAILURES = 10;
export const PASSWORD_FAILURE_WINDOW_SECONDS = 15 * 60;

/**
 * Checks a password: a local account by e-mail address first, then the
 * connected directories by their login attribute (a directory password is
 * checked by binding as the person; it is never stored). An account with too
 * many recent failures is not checked at all and answers like a wrong
 * password, so it reads the same as an unknown account. The attempt is
 * counted before the check, so parallel requests cannot pass the limit.
 */
export async function checkPassword(
  users: UserStore,
  directory: DirectoryAccess | undefined,
  identifier: string,
  password: string,
  onError?: (err: unknown) => void,
): Promise<SignInResult> {
  const known = await users.passwordAttempt(
    identifier,
    PASSWORD_FAILURES,
    PASSWORD_FAILURE_WINDOW_SECONDS,
  );
  if (known && !known.attempt.allowed) {
    // Spend the time a check takes, so a locked account is not told apart.
    await burnPasswordCheck(password);
    return { error: 'invalid', userId: known.id };
  }
  // A failure keeps counting; a sign-in or an unanswered directory does not.
  const forget = async () => {
    if (known) await users.forgetAttempt(known.attempt);
  };
  const invalid = { error: 'invalid' as const, ...(known ? { userId: known.id } : {}) };
  const local = await users.authenticate(identifier, password);
  if (local) {
    await forget();
    return { user: local };
  }
  if (!directory) return invalid;
  try {
    const id = await signInWithDirectory(directory.pool, directory.sources, identifier, password);
    const user = id ? await users.findById(id) : null;
    if (!user || user.disabled) return invalid;
    await forget();
    return { user };
  } catch (err) {
    onError?.(err);
    await forget();
    return { error: 'unavailable' };
  }
}

/** Whether people may type a username (a directory is connected). */
export async function usernamesAllowed(directory: DirectoryAccess | undefined): Promise<boolean> {
  if (!directory) return false;
  return (await directory.sources.list()).some((s) => s.enabled);
}

/**
 * Checks a passkey sign-in posted by the sign-in form (`challenge` and the
 * browser's `response` as JSON). The passkey's account must be active.
 */
export async function checkPasskey(
  users: UserStore,
  passkeys: PasskeyStore,
  purpose: SignInPurpose,
  body: { challenge?: string; response?: string } | undefined,
  interaction?: string,
): Promise<{ user: User; synced: boolean } | null> {
  let response: unknown;
  try {
    response = JSON.parse(body?.response ?? '');
  } catch {
    return null;
  }
  if (!isAssertion(response)) return null;
  const result = await passkeys.authenticate(purpose, body?.challenge ?? '', response, interaction);
  const user = result ? await users.findById(result.userId) : null;
  return user && !user.disabled ? { user, synced: result!.synced } : null;
}

function isAssertion(value: unknown): value is AuthenticationResponseJSON {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { id?: unknown; response?: unknown };
  return (
    typeof v.id === 'string' &&
    v.id.length <= 1024 &&
    typeof v.response === 'object' &&
    v.response !== null
  );
}

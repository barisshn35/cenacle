// SPDX-License-Identifier: AGPL-3.0-only
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type pg from 'pg';
import type { SourceStore } from '../directory/store.ts';
import { signInWithDirectory } from '../directory/sync.ts';
import type { PasskeyStore, SignInPurpose } from './passkeys.ts';
import type { User, UserStore } from './users.ts';

/** Directories people may sign in with (LDAP / Active Directory). */
export interface DirectoryAccess {
  pool: pg.Pool;
  sources: SourceStore;
}

export type SignInResult = { user: User } | { error: 'invalid' | 'unavailable' };

/**
 * Checks a password: a local account by e-mail address first, then the
 * connected directories by their login attribute (a directory password is
 * checked by binding as the person; it is never stored).
 */
export async function checkPassword(
  users: UserStore,
  directory: DirectoryAccess | undefined,
  identifier: string,
  password: string,
  onError?: (err: unknown) => void,
): Promise<SignInResult> {
  const local = await users.authenticate(identifier, password);
  if (local) return { user: local };
  if (!directory) return { error: 'invalid' };
  try {
    const id = await signInWithDirectory(directory.pool, directory.sources, identifier, password);
    const user = id ? await users.findById(id) : null;
    return user && !user.disabled ? { user } : { error: 'invalid' };
  } catch (err) {
    onError?.(err);
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

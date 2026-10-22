// SPDX-License-Identifier: Apache-2.0
import type pg from 'pg';
import type { SourceStore } from '../directory/store.ts';
import { signInWithDirectory } from '../directory/sync.ts';
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

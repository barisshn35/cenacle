// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readdirSync, renameSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Until 0.99.6 the app was named after its package, so its data lived in
 * "@cenacle/desktop" under the system's app data folder. The data moves once
 * to the folder named after the app ("Cenacle"), keeping the server, the
 * settings and the session; the uninstaller removes that folder. Nothing
 * happens when the new folder is there already.
 */
export function moveLegacyData(appData: string, userData: string): boolean {
  const old = join(appData, '@cenacle', 'desktop');
  if (old === userData || existsSync(userData) || !existsSync(old)) return false;
  try {
    renameSync(old, userData);
  } catch {
    return false; // in use or on another volume: the app starts fresh
  }
  try {
    if (readdirSync(dirname(old)).length === 0) rmdirSync(dirname(old));
  } catch {
    // An empty "@cenacle" folder left behind is harmless.
  }
  return true;
}

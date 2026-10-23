// SPDX-License-Identifier: AGPL-3.0-only
import { app, safeStorage } from 'electron';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** What the app remembers between starts (no secrets). */
export interface Config {
  /** The server the app is paired with (its origin), or null before pairing. */
  server: string | null;
  /** Servers used before, newest first. */
  recent: { origin: string; usedAt: string }[];
  /** The origin of Cenacle ID, learnt during sign-in (its pages open in the app). */
  idp: string | null;
  bounds?: { x: number; y: number; width: number; height: number; maximized: boolean };
  /** Closing the window keeps the app in the tray. */
  closeToTray: boolean;
}

const DEFAULTS: Config = { server: null, recent: [], idp: null, closeToTray: true };

const file = (name: string) => join(app.getPath('userData'), name);

function writeFile(name: string, data: string | Buffer) {
  const path = file(name);
  mkdirSync(dirname(path), { recursive: true });
  // Owner only: the session file is encrypted, but still nobody else's business.
  writeFileSync(path, data, { mode: 0o600 });
}

export function loadConfig(): Config {
  try {
    return { ...DEFAULTS, ...(JSON.parse(readFileSync(file('config.json'), 'utf8')) as Config) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(config: Config): void {
  writeFile('config.json', JSON.stringify(config, null, 2));
}

/** Records a server as used now, keeping the five most recent. */
export function remember(config: Config, origin: string): Config {
  const recent = [
    { origin, usedAt: new Date().toISOString() },
    ...config.recent.filter((r) => r.origin !== origin),
  ].slice(0, 5);
  return { ...config, recent };
}

/**
 * Whether the session can be kept on disk: only when the operating system
 * encrypts it (DPAPI on Windows, the keyring on Linux). Without a keyring
 * Electron falls back to a fixed key; then the session lasts until the app
 * quits instead of being written in a form anyone could read.
 */
export function canKeepSession(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (process.platform === 'linux') {
    const backend = safeStorage.getSelectedStorageBackend();
    return backend !== 'basic_text' && backend !== 'unknown';
  }
  return true;
}

let memoryToken: string | null = null;

/** The session token of the paired server, or null when signed out. */
export function loadToken(): string | null {
  if (memoryToken) return memoryToken;
  if (!canKeepSession()) return null;
  try {
    memoryToken = safeStorage.decryptString(readFileSync(file('session.bin')));
    return memoryToken;
  } catch {
    return null;
  }
}

export function saveToken(token: string): void {
  memoryToken = token;
  if (canKeepSession()) writeFile('session.bin', safeStorage.encryptString(token));
}

export function clearToken(): void {
  memoryToken = null;
  rmSync(file('session.bin'), { force: true });
}

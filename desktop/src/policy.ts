// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * What an organization decides for the app on its computers
 * (docs/desktop/enterprise-deployment.md): the server to use, whether people
 * may change it, and whether the app updates itself.
 */
export interface Policy {
  /** The server address the app pairs with ("" none). */
  server: string;
  /** People cannot change the server. */
  lockServer: boolean;
  /** The app does not look for updates (the organization deploys them). */
  disableUpdates: boolean;
}

export const NO_POLICY: Policy = { server: '', lockServer: false, disableUpdates: false };

/** The registry keys, machine first: a machine setting wins over the user's. */
export const REGISTRY_KEYS = [
  'HKLM\\SOFTWARE\\Policies\\Cenacle\\Desktop',
  'HKCU\\SOFTWARE\\Policies\\Cenacle\\Desktop',
];

/** The policy file on Linux (tests name another one). */
export const POLICY_FILE = process.env.CENACLE_DESKTOP_POLICY || '/etc/cenacle/desktop-policy.json';

const on = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true';

/** Reads the values of `reg query <key>`: "    Server    REG_SZ    https://…". */
export function parseRegistry(output: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s+(\S+)\s+(REG_SZ|REG_EXPAND_SZ|REG_DWORD)\s+(.*?)\s*$/.exec(line);
    if (!m) continue;
    const [, name, type, raw] = m;
    values[name!.toLowerCase()] = type === 'REG_DWORD' ? String(Number(raw)) : raw!;
  }
  return values;
}

/** Merges values (by lower-case name), the earlier source winning. */
export function policyFrom(sources: Record<string, unknown>[]): Policy {
  const pick = (name: string) => sources.find((s) => s[name] !== undefined)?.[name];
  const server = pick('server');
  return {
    server: typeof server === 'string' ? server.trim() : '',
    lockServer: on(pick('lockserver')),
    disableUpdates: on(pick('disableupdates')),
  };
}

function lowerKeys(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));
}

/** The policy of this computer; none when nothing is set or it cannot be read. */
export function readPolicy(): Policy {
  try {
    if (process.platform === 'win32') {
      const sources = REGISTRY_KEYS.map((key) => {
        const r = spawnSync('reg.exe', ['query', key], {
          encoding: 'utf8',
          timeout: 5000,
          windowsHide: true,
        });
        return r.status === 0 ? parseRegistry(r.stdout) : {};
      });
      return policyFrom(sources);
    }
    if (process.platform === 'linux') {
      const data = JSON.parse(readFileSync(POLICY_FILE, 'utf8')) as Record<string, unknown>;
      return policyFrom([lowerKeys(data)]);
    }
  } catch {
    // No policy file, or one that is not JSON: nothing is decided.
  }
  return NO_POLICY;
}

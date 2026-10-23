// SPDX-License-Identifier: AGPL-3.0-only
import { app, net } from 'electron';

export type PairError = 'invalid' | 'insecure' | 'unreachable' | 'notCenacle' | 'tooOld';

/** Hosts where plain http is allowed (development on this computer). */
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The origin of a server address as people type it ("chat.example.com",
 * "https://chat.example.com/c/x"): https unless the address says otherwise.
 */
export function normalize(input: string): { origin: string } | { error: PairError } {
  const raw = input.trim();
  if (!raw || /\s/.test(raw)) return { error: 'invalid' };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { error: 'invalid' };
  }
  // Single-label intranet names ("chat") are fine; credentials in the address are not.
  if (url.username || url.password || !url.hostname) return { error: 'invalid' };
  if (url.protocol === 'http:' && !LOCAL.has(url.hostname)) return { error: 'insecure' };
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: 'invalid' };
  return { origin: url.origin };
}

/** 0.30.0 < 0.30.1 < 0.31.0; prerelease parts are ignored. */
export function olderThan(version: string, min: string): boolean {
  const parts = (v: string) =>
    v
      .split('-')[0]!
      .split('.')
      .map((n) => Number(n) || 0);
  const [a, b] = [parts(version), parts(min)];
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

export interface Meta {
  web_app: boolean;
  desktop_min_version: string;
}

/** Asks a server what it is, within ten seconds. */
export async function check(
  origin: string,
): Promise<{ meta: Meta } | { error: PairError; version?: string }> {
  let res: Response;
  try {
    res = await net.fetch(`${origin}/api/meta`, { signal: AbortSignal.timeout(10_000) });
  } catch {
    return { error: 'unreachable' };
  }
  if (!res.ok) return { error: 'notCenacle' };
  let meta: Meta;
  try {
    meta = (await res.json()) as Meta;
  } catch {
    return { error: 'notCenacle' };
  }
  if (typeof meta?.web_app !== 'boolean') return { error: 'notCenacle' };
  const min = meta.desktop_min_version ?? '';
  if (min && olderThan(app.getVersion(), min)) return { error: 'tooOld', version: min };
  return { meta };
}

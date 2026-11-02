// SPDX-License-Identifier: AGPL-3.0-only
/**
 * One browser profile (one IndexedDB, one local storage) used by more than
 * one person, page load after page load.
 */
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const AYSE = '11111111-1111-4111-8111-111111111111';
const MERT = '22222222-2222-4222-8222-222222222222';
const CH = '33333333-3333-4333-8333-333333333333';

const calls: string[] = [];

/** A page load: fresh modules on the same profile. */
async function page() {
  vi.resetModules();
  vi.doMock('@cenacle/core/api', () => ({
    ApiError: class extends Error {},
    apiFetch: async (path: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      return undefined;
    },
  }));
  return {
    browser: await import('./browser-data'),
    keys: await import('../compliance/e2e'),
    db: await import('../e2e/db'),
  };
}

/** Ayşe unlocks a passphrase channel and opens an MLS text here. */
async function ayseUsesEncryption(p: Awaited<ReturnType<typeof page>>) {
  await p.browser.claimBrowser(AYSE);
  const { key } = await p.keys.newKeyCheck('dummy-pass');
  p.keys.useChannelKeys.getState().set(CH, key);
  await p.db.put('device', AYSE, { id: 'dev-ayse', userId: AYSE });
  await p.db.put('plain', 'h1', { channelId: CH, payload: { v: 1, t: 'gizli' }, s: AYSE });
  await vi.waitFor(async () => {
    await p.keys.loadKeys();
    expect(p.keys.useChannelKeys.getState().keys[CH]).toBeDefined();
  });
}

const store = new Map<string, string>();

describe('what this browser keeps for a person', () => {
  beforeEach(() => {
    (globalThis as { indexedDB?: IDBFactory }).indexedDB = new IDBFactory();
    store.clear();
    calls.length = 0;
    (globalThis as { localStorage?: Storage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    };
  });

  it('stays for the same person from page to page', async () => {
    await ayseUsesEncryption(await page());
    const p = await page();
    await p.browser.claimBrowser(AYSE);
    expect(p.keys.useChannelKeys.getState().keys[CH]).toBeDefined();
    expect(await p.db.get('plain', 'h1')).toBeDefined();
  });

  it('is not given to the next person', async () => {
    await ayseUsesEncryption(await page());
    const p = await page();
    await p.browser.claimBrowser(MERT);
    expect(p.keys.useChannelKeys.getState().keys[CH]).toBeUndefined();
    expect(await p.db.get('plain', 'h1')).toBeUndefined();
    expect(await p.db.get('device', AYSE)).toBeUndefined();
  });

  it('goes when the session ends without signing out', async () => {
    const first = await page();
    await ayseUsesEncryption(first);
    // The session timed out (or was ended elsewhere) while the app was open.
    await first.browser.sessionEnded();
    expect(first.keys.useChannelKeys.getState().keys).toEqual({});
    expect(await first.db.get('plain', 'h1')).toBeUndefined();

    // Ayşe signs in again: nothing is back, and the server forgets the old device.
    const p = await page();
    await p.browser.claimBrowser(AYSE);
    expect(p.keys.useChannelKeys.getState().keys[CH]).toBeUndefined();
    expect(calls).toContain('DELETE /api/e2e/devices/dev-ayse');
  });
});

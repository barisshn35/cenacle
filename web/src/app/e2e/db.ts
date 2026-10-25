// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What end-to-end encryption keeps on this device (IndexedDB "cenacle-mls"):
 * the device's signing key, each channel's MLS group state, the texts this
 * device opened (an MLS message opens only once) and the recovery key.
 * Nothing here leaves the device unencrypted.
 */

const NAME = 'cenacle-mls';
const VERSION = 1;
export const STORES = ['device', 'groups', 'plain', 'meta'] as const;
export type Store = (typeof STORES)[number];

let opening: Promise<IDBDatabase> | null = null;
// The browser's IndexedDB as this module found it (tests give each "browser" its own).
const factory: IDBFactory | undefined = typeof indexedDB === 'undefined' ? undefined : indexedDB;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    if (!factory) return reject(new Error('no IndexedDB'));
    const req = factory.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      for (const s of STORES) {
        if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      opening = null;
      reject(req.error ?? new Error('indexedDB'));
    };
  });
  return opening;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB'));
  });
}

export async function get<T>(store: Store, key: string): Promise<T | undefined> {
  const db = await open();
  return done(db.transaction(store).objectStore(store).get(key)) as Promise<T | undefined>;
}

export async function put(store: Store, key: string, value: unknown): Promise<void> {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value, key);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('indexedDB'));
  });
}

export async function del(store: Store, key: string): Promise<void> {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('indexedDB'));
  });
}

/** Everything this device keeps for encryption goes (signing out on a shared computer). */
export async function wipe(): Promise<void> {
  const db = await open();
  const tx = db.transaction([...STORES], 'readwrite');
  for (const s of STORES) tx.objectStore(s).clear();
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('indexedDB'));
  });
}

/**
 * Runs fn alone across this browser's tabs for one name (a group's state is
 * read, changed and written back as a whole).
 */
export async function exclusive<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(`cenacle-mls:${name}`, fn);
  }
  return fn();
}

export const b64 = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
};

export const unb64 = (s: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function sha256(data: Uint8Array<ArrayBuffer> | string): Promise<Uint8Array> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

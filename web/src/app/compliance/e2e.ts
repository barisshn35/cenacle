// SPDX-License-Identifier: AGPL-3.0-only
/**
 * End-to-end encrypted channels. Members share a passphrase outside Cenacle;
 * the key is derived in the browser (PBKDF2-SHA-256, 600,000 rounds, a
 * random salt kept in the channel's key check), kept on this device only (a non-extractable CryptoKey
 * in IndexedDB) and never sent anywhere. Bodies travel as
 * "e2e:v1:<iv>:<ciphertext>" (AES-256-GCM, base64).
 */
import { create } from 'zustand';

const PREFIX = 'e2e:v1:';
const CHECK = 'cenacle-key-check';
const ROUNDS = 600_000;
const DB = 'cenacle-keys';
const STORE = 'keys';

const b64 = (bytes: Uint8Array) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const isEnvelope = (body: string) => body.startsWith(PREFIX);

export async function deriveKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase.normalize('NFC')),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt,
      iterations: ROUNDS,
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encrypt(key: CryptoKey, text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(text),
  );
  const envelope = `${PREFIX}${b64(iv)}:${b64(new Uint8Array(data))}`;
  plain.set(envelope, text);
  return envelope;
}

/** Texts opened on this page, by envelope. */
const plain = new Map<string, string>();

/** The text of an envelope, or null when the key does not open it. */
export async function decrypt(key: CryptoKey, envelope: string): Promise<string | null> {
  const known = plain.get(envelope);
  if (known !== undefined) return known;
  if (!isEnvelope(envelope)) return null;
  const [iv, data] = envelope.slice(PREFIX.length).split(':');
  if (!iv || !data) return null;
  try {
    const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(data));
    const text = new TextDecoder().decode(bytes);
    plain.set(envelope, text);
    return text;
  } catch {
    return null;
  }
}

/** A body as far as this page could open it (envelopes it could not: null). */
export const plainOf = (body: string): string | null =>
  isEnvelope(body) ? (plain.get(body) ?? null) : body;

/** A new channel's salt and key check ("s:<salt>:" and a known text sealed with the key). */
export async function newKeyCheck(passphrase: string): Promise<{ key: CryptoKey; check: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(passphrase, salt);
  return { key, check: `s:${b64(salt)}:${await encrypt(key, CHECK)}` };
}

/** The key of a passphrase for a channel's key check, or null when it is the wrong one. */
export async function unlock(passphrase: string, check: string): Promise<CryptoKey | null> {
  const m = /^s:([A-Za-z0-9+/]{22}==):(e2e:v1:.*)$/.exec(check);
  if (!m) return null;
  const key = await deriveKey(passphrase, unb64(m[1]!));
  return (await decrypt(key, m[2]!)) === CHECK ? key : null;
}

// --- keys on this device --------------------------------------------------------------

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB'));
  });
}

async function persist(channelId: string, key: CryptoKey | null) {
  try {
    const d = await db();
    const tx = d.transaction(STORE, 'readwrite');
    if (key) tx.objectStore(STORE).put(key, channelId);
    else tx.objectStore(STORE).delete(channelId);
  } catch {
    // Private windows: the key lasts as long as the page.
  }
}

async function loadAll(): Promise<Record<string, CryptoKey>> {
  try {
    const d = await db();
    return await new Promise((resolve) => {
      const out: Record<string, CryptoKey> = {};
      const req = d.transaction(STORE).objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve(out);
        out[String(c.key)] = c.value as CryptoKey;
        c.continue();
      };
      req.onerror = () => resolve(out);
    });
  } catch {
    return {};
  }
}

/** Keys of encrypted channels on this device, by channel. */
export const useChannelKeys = create<{
  keys: Record<string, CryptoKey>;
  loaded: boolean;
  set: (channelId: string, key: CryptoKey | null) => void;
}>((set) => ({
  keys: {},
  loaded: false,
  set: (channelId, key) => {
    void persist(channelId, key);
    set((s) => {
      const keys = { ...s.keys };
      if (key) keys[channelId] = key;
      else delete keys[channelId];
      return { keys };
    });
  },
}));

if (typeof indexedDB !== 'undefined') {
  void loadAll().then((keys) =>
    useChannelKeys.setState((s) => ({ keys: { ...keys, ...s.keys }, loaded: true })),
  );
} else {
  useChannelKeys.setState({ loaded: true });
}

/** Encrypts a body for its channel when the channel has a key here. */
export async function sealFor(channelId: string, body: string): Promise<string> {
  const key = useChannelKeys.getState().keys[channelId];
  return key && body ? encrypt(key, body) : body;
}

/** Whether the person can write in a channel here: encrypted ones need their key. */
export function useCanWrite(channel: { id: string; encrypted?: boolean } | undefined) {
  const key = useChannelKeys((s) => (channel ? s.keys[channel.id] : undefined));
  return !channel?.encrypted || !!key;
}

// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Recovery key and history backups. A new device cannot open messages from
 * before it joined a group, so devices keep the texts they read in backups
 * sealed with the person's recovery key (32 random bytes, shown once as a
 * code). With the code, another device restores the history.
 *
 *   verifier   = HMAC-SHA-256(recovery key, "cenacle-recovery-check")
 *   backup key = HKDF-SHA-256(recovery key, salt "", info "cenacle-backup-v1")
 *   backup     = 0x01 ‖ iv (12) ‖ AES-256-GCM(JSON { items: [{ h, p }] })
 *
 * When the organization requires escrow, the recovery key is also sealed for
 * its P-256 key (ECDH with a one-time key, HKDF info "cenacle-escrow-v1"
 * salted with that key, AES-256-GCM): 0x01 ‖ one-time key (65) ‖ iv ‖ sealed.
 */
import { apiFetch, type components } from '@cenacle/core/api';
import { b64, get, put, unb64 } from './db';
import { onRemember, restore, type Payload } from './mls';

export type Recovery = components['schemas']['E2ERecovery'];

const LABEL = 'cenacle-recovery-check';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I

const subtle = () => crypto.subtle;
const enc = new TextEncoder();
const buf = (b: Uint8Array) => new Uint8Array(b) as Uint8Array<ArrayBuffer>;

/** 32 bytes as 52 characters, in groups of four. */
export function formatKey(key: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of key) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out.match(/.{1,4}/g)!.join(' ');
}

/** The key of a typed code (spaces, dashes and case do not matter), or null. */
export function parseKey(code: string): Uint8Array | null {
  const clean = code.toUpperCase().replace(/[\s-]/g, '');
  if (clean.length !== 52) return null;
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) return null;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return out.length >= 32 ? new Uint8Array(out.slice(0, 32)) : null;
}

export async function verifierOf(key: Uint8Array): Promise<Uint8Array> {
  const k = await subtle().importKey('raw', buf(key), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return new Uint8Array(await subtle().sign('HMAC', k, enc.encode(LABEL)));
}

async function backupKey(key: Uint8Array): Promise<CryptoKey> {
  const ikm = await subtle().importKey('raw', buf(key), 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(),
      info: enc.encode('cenacle-backup-v1'),
    },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function sealBackup(key: Uint8Array, data: unknown): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await subtle().encrypt(
      { name: 'AES-GCM', iv },
      await backupKey(key),
      enc.encode(JSON.stringify(data)),
    ),
  );
  const out = new Uint8Array(1 + 12 + ct.length);
  out.set([1]);
  out.set(iv, 1);
  out.set(ct, 13);
  return out;
}

export async function openBackup<T>(key: Uint8Array, blob: Uint8Array): Promise<T | null> {
  if (blob[0] !== 1 || blob.length < 13 + 16) return null;
  try {
    const plain = await subtle().decrypt(
      { name: 'AES-GCM', iv: buf(blob.subarray(1, 13)) },
      await backupKey(key),
      buf(blob.subarray(13)),
    );
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch {
    return null;
  }
}

/** The recovery key sealed for the organization's escrow key (SPKI, P-256). */
export async function sealForEscrow(key: Uint8Array, escrowSpki: Uint8Array): Promise<Uint8Array> {
  const escrow = await subtle().importKey(
    'spki',
    buf(escrowSpki),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const once = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const shared = await subtle().deriveBits({ name: 'ECDH', public: escrow }, once.privateKey, 256);
  const pub = new Uint8Array(await subtle().exportKey('raw', once.publicKey));
  const ikm = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const kek = await subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: pub, info: enc.encode('cenacle-escrow-v1') },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, kek, buf(key)));
  const out = new Uint8Array(1 + pub.length + 12 + ct.length);
  out.set([1]);
  out.set(pub, 1);
  out.set(iv, 1 + pub.length);
  out.set(ct, 13 + pub.length);
  return out;
}

// --- this device's recovery key ---------------------------------------------------------

const slot = (userId: string) => `recovery:${userId}`;

export const recoveryQuery = (userId: string) => ({
  queryKey: ['e2e-recovery', userId],
  queryFn: () => apiFetch<Recovery>('/api/e2e/recovery'),
});

export const localKey = (userId: string) => get<Uint8Array>('meta', slot(userId));

/** Makes a new recovery key (the old backups go) and keeps it on this device. */
export async function createRecovery(
  userId: string,
): Promise<{ code: string; recovery: Recovery }> {
  const current = await apiFetch<Recovery>('/api/e2e/recovery');
  const key = crypto.getRandomValues(new Uint8Array(32));
  const body: Record<string, string> = { verifier: b64(await verifierOf(key)) };
  if (current.escrow_key) {
    body.escrow = b64(await sealForEscrow(key, unb64(current.escrow_key.public_key)));
    body.escrow_key_id = current.escrow_key.key_id;
  }
  const recovery = await apiFetch<Recovery>('/api/e2e/recovery', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  await put('meta', slot(userId), key);
  return { code: formatKey(key), recovery };
}

/** Takes a typed recovery code on this device; false when it is not the person's key. */
export async function takeRecoveryCode(userId: string, code: string): Promise<boolean> {
  const key = parseKey(code);
  if (!key) return false;
  const current = await apiFetch<Recovery>('/api/e2e/recovery');
  if (!current.verifier) return false;
  const expected = unb64(current.verifier);
  const got = await verifierOf(key);
  if (expected.length !== got.length || !expected.every((b, i) => b === got[i])) return false;
  await put('meta', slot(userId), key);
  restored.clear();
  return true;
}

// --- backups ------------------------------------------------------------------------------

const queue = new Map<string, { h: string; p: Payload }[]>();
let timer: ReturnType<typeof setTimeout> | null = null;
let owner: string | null = null;

/** Starts keeping what this device reads in the person's backups. */
export function startBackups(userId: string) {
  owner = userId;
  onRemember((channelId, h, p) => {
    const list = queue.get(channelId) ?? [];
    list.push({ h, p });
    queue.set(channelId, list);
    if (list.length >= 50) void flush();
    else timer ??= setTimeout(() => void flush(), 15_000);
  });
}

export async function flush() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!owner) return;
  const key = await localKey(owner);
  if (!key) {
    queue.clear();
    return;
  }
  for (const [channelId, items] of [...queue]) {
    queue.delete(channelId);
    try {
      await apiFetch<void>(`/api/channels/${channelId}/e2e/backups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: b64(await sealBackup(key, { items })) }),
      });
    } catch {
      // Kept for the next try.
      queue.set(channelId, [...items, ...(queue.get(channelId) ?? [])]);
    }
  }
}

const restored = new Set<string>();

/** Brings a channel's history backups to this device (once per page load). */
export async function restoreChannel(userId: string, channelId: string): Promise<number> {
  if (restored.has(channelId)) return 0;
  const key = await localKey(userId);
  if (!key) return 0;
  restored.add(channelId);
  let after = '';
  let count = 0;
  for (;;) {
    const page = await apiFetch<{ backups: { id: string; data: string }[] }>(
      `/api/channels/${channelId}/e2e/backups${after ? `?after=${after}` : ''}`,
    );
    for (const b of page.backups) {
      const data = await openBackup<{ items: { h: string; p: Payload }[] }>(key, unb64(b.data));
      if (data?.items) {
        await restore(channelId, data.items);
        count += data.items.length;
      }
    }
    if (page.backups.length < 50) return count;
    after = page.backups[page.backups.length - 1]!.id;
  }
}

// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';

vi.mock('@cenacle/core/api', () => ({ apiFetch: vi.fn(), ApiError: Error }));

const { formatKey, openBackup, parseKey, sealBackup, sealForEscrow, verifierOf } =
  await import('./recovery');

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

describe('recovery keys', () => {
  it('reads back the code it shows', () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const code = formatKey(key);
    expect(code).toMatch(/^([A-Z2-9]{4} ){12}[A-Z2-9]{4}$/);
    expect(parseKey(code)).toEqual(key);
    expect(parseKey(code.toLowerCase().replace(/ /g, '-'))).toEqual(key);
    expect(parseKey(code.slice(0, -1))).toBeNull();
    expect(parseKey(code.replace(/^./, '0'))).toBeNull();
  });

  it('seals and opens backups', async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const blob = await sealBackup(key, { items: [{ h: 'x', p: { v: 1, t: 'merhaba' } }] });
    expect(blob[0]).toBe(1);
    expect(await openBackup(key, blob)).toEqual({ items: [{ h: 'x', p: { v: 1, t: 'merhaba' } }] });
    expect(await openBackup(crypto.getRandomValues(new Uint8Array(32)), blob)).toBeNull();
    expect(await verifierOf(key)).toHaveLength(32);
  });

  it('seals the recovery key for the escrow key', async () => {
    const escrow = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
      'deriveBits',
    ]);
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', escrow.publicKey));
    const key = crypto.getRandomValues(new Uint8Array(32));
    const sealed = await sealForEscrow(key, spki);
    expect(sealed).toHaveLength(1 + 65 + 12 + 48);
    // Open it the way the server's e2e-escrow command does.
    const once = await crypto.subtle.importKey(
      'raw',
      sealed.slice(1, 66),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );
    const shared = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: once },
      escrow.privateKey,
      256,
    );
    const ikm = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    const kek = await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: sealed.slice(1, 66),
        info: new TextEncoder().encode('cenacle-escrow-v1'),
      },
      ikm,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );
    const opened = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: sealed.slice(66, 78) },
      kek,
      sealed.slice(78),
    );
    expect(new Uint8Array(opened)).toEqual(key);

    if (
      (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env
        .PRINT_VECTOR
    ) {
      const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', escrow.privateKey));
      const backup = await sealBackup(key, { items: [{ h: 'h1', p: { v: 1, t: 'Gizli plan' } }] });
      console.log(
        JSON.stringify({
          pkcs8: hex(pkcs8),
          key: hex(key),
          escrow: hex(sealed),
          backup: hex(backup),
        }),
      );
    }
  });
});

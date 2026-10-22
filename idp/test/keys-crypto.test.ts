// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openPrivateKey, sealPrivateKey } from '../src/keys/crypto.ts';

const kek = randomBytes(32);

describe('signing key encryption', () => {
  it('round-trips', () => {
    const sealed = sealPrivateKey(kek, 'kid-1', '{"d":"secret"}');
    expect(sealed.toString('utf8')).not.toContain('secret');
    expect(openPrivateKey(kek, 'kid-1', sealed)).toBe('{"d":"secret"}');
  });

  it('uses a fresh IV every time', () => {
    expect(sealPrivateKey(kek, 'k', 'x').equals(sealPrivateKey(kek, 'k', 'x'))).toBe(false);
  });

  it('rejects a wrong key, a moved row and tampering', () => {
    const sealed = sealPrivateKey(kek, 'kid-1', 'payload');
    expect(() => openPrivateKey(randomBytes(32), 'kid-1', sealed)).toThrow();
    expect(() => openPrivateKey(kek, 'kid-2', sealed)).toThrow();
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1]! ^= 1;
    expect(() => openPrivateKey(kek, 'kid-1', tampered)).toThrow();
  });
});

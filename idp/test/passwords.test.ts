// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  fipsMode,
  hashPassword,
  needsRehash,
  pbkdf2Hash,
  verifyPassword,
} from '../src/accounts/passwords.ts';

describe('password hashes', () => {
  it('uses Argon2id outside FIPS mode and moves PBKDF2 hashes to it', async () => {
    expect(fipsMode()).toBe(false);
    const h = await hashPassword('correct horse battery staple');
    expect(h).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(h, 'correct horse battery staple')).toBe(true);
    expect(needsRehash(h)).toBe(false);
  });

  it('verifies PBKDF2-HMAC-SHA-512 hashes (FIPS mode)', async () => {
    const h = await pbkdf2Hash('çok gizli bir parola cümlesi');
    expect(h).toMatch(/^\$pbkdf2-sha512\$i=210000\$[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{88}$/);
    expect(await verifyPassword(h, 'çok gizli bir parola cümlesi')).toBe(true);
    // The same text in another Unicode form is the same password.
    expect(await verifyPassword(h, 'çok gizli bir parola cümlesi'.normalize('NFD'))).toBe(true);
    expect(await verifyPassword(h, 'wrong')).toBe(false);
    expect(await verifyPassword(h.replace('i=210000', 'i=0'), 'çok gizli bir parola cümlesi')).toBe(
      false,
    );
    expect(await verifyPassword('$pbkdf2-sha512$garbage', 'x')).toBe(false);
    // Outside FIPS mode it moves to Argon2id at the next sign-in.
    expect(needsRehash(h)).toBe(true);
  });
});

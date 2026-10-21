// SPDX-License-Identifier: Apache-2.0
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Encrypts a private key for storage: iv (12) || tag (16) || ciphertext.
 * The key id is bound as additional authenticated data, so a ciphertext
 * copied to another row does not decrypt.
 */
export function sealPrivateKey(kek: Buffer, kid: string, plaintext: string): Buffer {
  if (kek.length !== 32) throw new Error('key encryption key must be 32 bytes');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, kek, iv);
  cipher.setAAD(Buffer.from(kid, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

/** Decrypts a value produced by sealPrivateKey; throws if it was tampered with. */
export function openPrivateKey(kek: Buffer, kid: string, sealed: Buffer): string {
  if (sealed.length <= IV_BYTES + TAG_BYTES) throw new Error('sealed key is too short');
  const iv = sealed.subarray(0, IV_BYTES);
  const tag = sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, kek, iv);
  decipher.setAAD(Buffer.from(kid, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(sealed.subarray(IV_BYTES + TAG_BYTES)),
    decipher.final(),
  ]).toString('utf8');
}

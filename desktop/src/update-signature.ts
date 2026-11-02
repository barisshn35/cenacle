// SPDX-License-Identifier: AGPL-3.0-only
import { createPublicKey, verify } from 'node:crypto';
import { UPDATE_KEYS } from './update-keys.js';

/**
 * An update file (latest.yml, latest-linux.yml, …) is signed with the
 * release key together with its name, so one platform's file cannot stand in
 * for another's. The signature, base64, is next to it as <name>.sig.
 * scripts/sign-updates.mjs signs with the same message.
 */
export function signedMessage(name: string, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`cenacle-update-v1\n${name}\n`, 'utf8'), data]);
}

/** Whether one of the keys signed the update file. */
export function verifyUpdateFile(
  name: string,
  data: Buffer,
  signature: string,
  keys: readonly string[] = UPDATE_KEYS,
): boolean {
  const sig = Buffer.from(signature.trim(), 'base64');
  if (sig.length !== 64) return false;
  const message = signedMessage(name, data);
  return keys.some((pem) => {
    try {
      return verify(null, message, createPublicKey(pem), sig);
    } catch {
      return false;
    }
  });
}

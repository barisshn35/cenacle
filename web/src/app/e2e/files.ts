// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Files of channels encrypted with device keys: encrypted in the browser with
 * a key of their own (AES-256-GCM), which travels inside the MLS message. The
 * server keeps the ciphertext under the name "encrypted", without previews.
 */
import { b64, unb64 } from './db';
import type { FileKey } from './mls';

export async function encryptFile(file: Blob): Promise<{ blob: Blob; k: string; iv: string }> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, await file.arrayBuffer());
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  return { blob: new Blob([data]), k: b64(raw), iv: b64(iv) };
}

export async function decryptBytes(
  data: ArrayBuffer,
  ref: Pick<FileKey, 'k' | 'iv'>,
): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', unb64(ref.k), 'AES-GCM', false, ['decrypt']);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ref.iv) }, key, data);
}

/** The file, decrypted, as a Blob of its own type. */
export async function decryptFile(ref: FileKey): Promise<Blob> {
  const res = await fetch(`/api/files/${ref.id}/content`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`file ${res.status}`);
  return new Blob([await decryptBytes(await res.arrayBuffer(), ref)], {
    type: ref.type || 'application/octet-stream',
  });
}

/** Keys of files uploaded on this page, until their message is sent. */
export const fileKeys = new Map<string, FileKey>();

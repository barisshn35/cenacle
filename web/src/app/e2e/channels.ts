// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Which channels are encrypted with device keys, and sending into them. The
 * channel lists note the channels as they load; the session gives the person.
 */
import { fileKeys } from './files';
import { groupChanged, send, type FileKey } from './mls';
import { startBackups } from './recovery';

const mls = new Set<string>();
let self: string | null = null;

export function noteChannels(list: { id: string; mls?: boolean }[]) {
  for (const c of list) {
    if (c.mls) mls.add(c.id);
    else mls.delete(c.id);
  }
}

export const isMLS = (channelId: string) => mls.has(channelId);

/** The signed-in person (encryption keys are per person and device). */
export function startE2E(userId: string) {
  if (self === userId) return;
  self = userId;
  startBackups(userId);
}

export const selfId = () => self;

/** An e2e.changed event: the group has new commits or devices to remove. */
export function onGroupEvent(channelId: string) {
  mls.add(channelId);
  if (self) groupChanged(channelId, self);
}

/**
 * Sends a text (and files uploaded on this page) into a channel encrypted
 * with device keys: post receives the envelope.
 */
export function sendSealed<T>(
  channelId: string,
  text: string,
  fileIds: string[],
  post: (envelope: string) => Promise<T>,
): Promise<T> {
  if (!self) return Promise.reject(new Error('not signed in'));
  const f = fileIds.map((id) => fileKeys.get(id)).filter((k): k is FileKey => !!k);
  return send(channelId, self, { v: 1, t: text, ...(f.length ? { f } : {}) }, post);
}

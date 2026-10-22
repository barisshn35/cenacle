// SPDX-License-Identifier: Apache-2.0
import { create } from 'zustand';
import type { FileInfo } from './files';

/** A message on its way to the server, shown until the server has it. */
export interface PendingMessage {
  nonce: string;
  channelId: string;
  body: string;
  /** People the body mentions (<@id>), to show their names meanwhile. */
  mentions?: { id: string; display_name: string }[];
  /** Uploaded files the message carries. */
  files?: FileInfo[];
  /** A reply: the thread's first message. */
  rootId?: string;
  /** A reply also sent to the channel. */
  alsoInChannel?: boolean;
  /** A sticker sent as the message. */
  sticker?: { id: string; name: string; url: string };
  /** Burn-on-read: seconds each recipient can read it for. */
  burnSeconds?: number;
  status: 'sending' | 'failed';
  /** Seconds to wait when the server said "too fast". */
  retryAfter?: number;
  /** Why the workspace did not take it (AutoMod, a timeout, slow mode). */
  reason?: string;
  createdAt: number;
}

interface PendingState {
  items: PendingMessage[];
  add(m: PendingMessage): void;
  update(nonce: string, patch: Partial<PendingMessage>): void;
  remove(nonce: string): void;
}

export const usePending = create<PendingState>()((set) => ({
  items: [],
  add: (m) => set((s) => ({ items: [...s.items, m] })),
  update: (nonce, patch) =>
    set((s) => ({ items: s.items.map((m) => (m.nonce === nonce ? { ...m, ...patch } : m)) })),
  remove: (nonce) => set((s) => ({ items: s.items.filter((m) => m.nonce !== nonce) })),
}));

export function newNonce(): string {
  return crypto.randomUUID();
}

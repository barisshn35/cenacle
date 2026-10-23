// SPDX-License-Identifier: AGPL-3.0-only
import { create } from 'zustand';

/**
 * Where reading stands after marking unread: unread from a message on, or
 * after a read position (null: all of it).
 */
export interface Hold {
  after: string | null;
  from?: string;
}

/**
 * Channels and threads marked unread while open. They stay unread while the
 * reader looks at them: reading starts again once they leave, send something
 * there, or read it on another device.
 */
export const useUnreadHold = create<{
  held: Record<string, Hold>;
  hold: (key: string, at: Hold) => void;
  release: (key: string) => void;
}>((set) => ({
  held: {},
  hold: (key, at) => set((s) => ({ held: { ...s.held, [key]: at } })),
  release: (key) =>
    set((s) => {
      if (!(key in s.held)) return s;
      const { [key]: _, ...rest } = s.held;
      return { held: rest };
    }),
}));

/** The hold key of a thread (channels are held by their id). */
export const threadKey = (rootId: string) => `thread:${rootId}`;

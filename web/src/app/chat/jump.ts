// SPDX-License-Identifier: AGPL-3.0-only
import { create } from 'zustand';

/** A message to bring into view once its channel's list is open. */
export interface JumpTarget {
  channelId: string;
  messageId: string;
}

interface JumpState {
  target: JumpTarget | null;
  /** The message last jumped to, highlighted for a moment. */
  highlighted: string | null;
  jump: (target: JumpTarget) => void;
  done: (messageId: string | null) => void;
}

export const useJump = create<JumpState>()((set) => ({
  target: null,
  highlighted: null,
  jump: (target) => set({ target, highlighted: null }),
  done: (messageId) => set({ target: null, highlighted: messageId }),
}));

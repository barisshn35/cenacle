// SPDX-License-Identifier: Apache-2.0
import { create } from 'zustand';

/** What the right panel shows. */
export type RightView = 'details' | 'search' | 'thread';

/** The thread open in the right panel. */
export interface ThreadTarget {
  channelId: string;
  rootId: string;
}

/** Client-only UI layout state. Server data lives in TanStack Query; the channel is in the URL. */
interface LayoutState {
  detailsOpen: boolean;
  rightView: RightView;
  thread: ThreadTarget | null;
  setDetailsOpen: (open: boolean) => void;
  /** Opens the right panel on a view. */
  show: (view: RightView) => void;
  /** Opens a thread in the right panel. */
  openThread: (thread: ThreadTarget) => void;
}

export const useLayout = create<LayoutState>()((set) => ({
  // Details start open on wide screens and closed on phones.
  detailsOpen:
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? !window.matchMedia('(max-width: 767px)').matches
      : true,
  rightView: 'details',
  thread: null,
  setDetailsOpen: (open) => set({ detailsOpen: open }),
  show: (view) => set({ detailsOpen: true, rightView: view }),
  openThread: (thread) => set({ detailsOpen: true, rightView: 'thread', thread }),
}));

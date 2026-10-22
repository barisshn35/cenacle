// SPDX-License-Identifier: Apache-2.0
import { create } from 'zustand';

/** What the right panel shows. */
export type RightView = 'details' | 'search';

/** Client-only UI layout state. Server data lives in TanStack Query; the channel is in the URL. */
interface LayoutState {
  detailsOpen: boolean;
  rightView: RightView;
  setDetailsOpen: (open: boolean) => void;
  /** Opens the right panel on a view. */
  show: (view: RightView) => void;
}

export const useLayout = create<LayoutState>()((set) => ({
  // Details start open on wide screens and closed on phones.
  detailsOpen:
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? !window.matchMedia('(max-width: 767px)').matches
      : true,
  rightView: 'details',
  setDetailsOpen: (open) => set({ detailsOpen: open }),
  show: (view) => set({ detailsOpen: true, rightView: view }),
}));

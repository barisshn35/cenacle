// SPDX-License-Identifier: Apache-2.0
import { create } from 'zustand';

/** Client-only UI layout state. Server data lives in TanStack Query; the channel is in the URL. */
interface LayoutState {
  detailsOpen: boolean;
  setDetailsOpen: (open: boolean) => void;
}

export const useLayout = create<LayoutState>()((set) => ({
  // Details start open on wide screens and closed on phones.
  detailsOpen:
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? !window.matchMedia('(max-width: 767px)').matches
      : true,
  setDetailsOpen: (open) => set({ detailsOpen: open }),
}));

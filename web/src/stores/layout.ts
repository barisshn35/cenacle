// SPDX-License-Identifier: Apache-2.0
import { create } from 'zustand';

/** Client-only UI layout state. Server data lives in TanStack Query. */
interface LayoutState {
  activeWorkspaceId: string;
  activeChannelId: string;
  detailsOpen: boolean;
  selectWorkspace: (id: string) => void;
  selectChannel: (id: string) => void;
  setDetailsOpen: (open: boolean) => void;
}

export const useLayout = create<LayoutState>()((set) => ({
  activeWorkspaceId: 'w-ops',
  activeChannelId: 'c-general',
  // Details start open on wide screens and closed on phones.
  detailsOpen:
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? !window.matchMedia('(max-width: 767px)').matches
      : true,
  selectWorkspace: (id) => set({ activeWorkspaceId: id }),
  selectChannel: (id) => set({ activeChannelId: id }),
  setDetailsOpen: (open) => set({ detailsOpen: open }),
}));

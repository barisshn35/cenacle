// SPDX-License-Identifier: AGPL-3.0-only
import { create } from 'zustand';

type Dialog = 'edit' | 'status' | null;

/** Which profile dialog is open (they open from the card, the menu and settings). */
export const useProfileDialogs = create<{
  dialog: Dialog;
  open: (d: Exclude<Dialog, null>) => void;
  close: () => void;
}>()((set) => ({
  dialog: null,
  open: (dialog) => set({ dialog }),
  close: () => set({ dialog: null }),
}));

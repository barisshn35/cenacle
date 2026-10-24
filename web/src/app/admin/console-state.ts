// SPDX-License-Identifier: AGPL-3.0-only
import { create } from 'zustand';

/** Whether the system console is open (instance administrators). */
export const useSystemConsole = create<{ open: boolean; setOpen: (open: boolean) => void }>()(
  (set) => ({ open: false, setOpen: (open) => set({ open }) }),
);

// SPDX-License-Identifier: Apache-2.0
import { useEffect } from 'react';
import { create } from 'zustand';

export const useQuickSwitcher = create<{ open: boolean; setOpen: (open: boolean) => void }>()(
  (set) => ({ open: false, setOpen: (open) => set({ open }) }),
);

/** Ctrl+K / ⌘K anywhere opens the quick switcher. */
export function useQuickSwitcherShortcut() {
  const setOpen = useQuickSwitcher((s) => s.setOpen);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);
}

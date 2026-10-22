// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect } from 'react';
import { create } from 'zustand';
import { useLayout } from '../../stores/layout';

export const useQuickSwitcher = create<{ open: boolean; setOpen: (open: boolean) => void }>()(
  (set) => ({ open: false, setOpen: (open) => set({ open }) }),
);

/** Ctrl+K / ⌘K anywhere opens the quick switcher; Ctrl+Shift+F / ⌘⇧F opens search. */
export function useQuickSwitcherShortcut() {
  const setOpen = useQuickSwitcher((s) => s.setOpen);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(true);
      }
      // Ctrl+Shift+F / ⌘⇧F opens search.
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        useLayout.getState().show('search');
        requestAnimationFrame(() =>
          document.querySelector<HTMLInputElement>('[data-testid="search-panel"] input')?.focus(),
        );
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);
}

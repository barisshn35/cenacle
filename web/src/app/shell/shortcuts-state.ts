// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';
import { useLayout } from '../../stores/layout';
import { desktop } from '../desktop/desktop';

export const useShortcutsDialog = create<{ open: boolean; setOpen: (open: boolean) => void }>()(
  (set) => ({ open: false, setOpen: (open) => set({ open }) }),
);

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** How a key is written on this computer. */
export function keyName(key: string): string {
  if (!isMac) return key;
  return (
    ({ Ctrl: '⌘', Alt: '⌥', Shift: '⇧', Enter: '↩', Esc: 'Esc' } as Record<string, string>)[key] ??
    key
  );
}

interface Shortcut {
  /** Keys pressed together; several ways are separated in `or`. */
  keys: string[];
  or?: string[];
  label: string;
}

/** The shortcuts by group, as the dialog lists them. */
export function useShortcutGroups(): { title: string; items: Shortcut[] }[] {
  const { t } = useTranslation();
  const groups = [
    {
      title: t('shortcuts.groups.navigation'),
      items: [
        { keys: ['Ctrl', 'K'], label: t('shortcuts.jump') },
        { keys: ['Alt', '↑'], or: ['Alt', '↓'], label: t('shortcuts.channel') },
        { keys: ['Alt', 'Shift', '↑'], or: ['Alt', 'Shift', '↓'], label: t('shortcuts.unread') },
        { keys: ['Ctrl', 'Shift', 'F'], label: t('shortcuts.search') },
        { keys: ['Ctrl', '.'], label: t('shortcuts.details') },
        { keys: ['Ctrl', '/'], label: t('shortcuts.list') },
      ],
    },
    {
      title: t('shortcuts.groups.messages'),
      items: [
        { keys: ['Enter'], label: t('shortcuts.send') },
        { keys: ['Shift', 'Enter'], label: t('shortcuts.newLine') },
        { keys: ['↑'], label: t('shortcuts.editLast') },
        { keys: ['Shift', '↑'], label: t('shortcuts.replyLast') },
        { keys: ['Ctrl', 'Shift', '\\'], label: t('shortcuts.reactLast') },
        { keys: ['Alt', t('shortcuts.click')], label: t('shortcuts.markUnread') },
        { keys: ['Esc'], label: t('shortcuts.cancelEdit') },
      ],
    },
    {
      title: t('shortcuts.groups.formatting'),
      items: [
        { keys: ['Ctrl', 'B'], label: t('shortcuts.bold') },
        { keys: ['Ctrl', 'I'], label: t('shortcuts.italic') },
        { keys: ['Ctrl', 'Shift', 'X'], label: t('shortcuts.strike') },
        { keys: ['Ctrl', 'E'], label: t('shortcuts.code') },
      ],
    },
  ];
  if (desktop) {
    groups.push({
      title: t('shortcuts.groups.app'),
      items: [
        { keys: ['Ctrl', '+'], or: ['Ctrl', '-'], label: t('shortcuts.zoom') },
        { keys: ['Ctrl', '0'], label: t('shortcuts.zoomReset') },
        { keys: ['Ctrl', 'R'], label: t('shortcuts.reload') },
        { keys: ['F11'], label: t('shortcuts.fullScreen') },
      ],
    });
  }
  return groups;
}

/** Moves to the channel above or below the current one in the sidebar (unread ones only). */
function moveChannel(step: 1 | -1, unreadOnly: boolean) {
  const nav = document.querySelector('[data-sidebar="content"]');
  const items = [...(nav?.querySelectorAll<HTMLLIElement>('li') ?? [])].filter((li) => {
    const link = li.querySelector<HTMLAnchorElement>(':scope > a[href^="/c/"]');
    // Folded sections and gathered copies are skipped (hidden from view).
    return !!link && link.offsetParent !== null;
  });
  if (items.length === 0) return;
  const n = items.length;
  const found = items.findIndex((li) => li.querySelector(':scope > a[aria-current="page"]'));
  // From outside the list, down starts at the top and up at the bottom.
  const current = found >= 0 ? found : step === 1 ? -1 : n;
  for (let i = 1; i <= n; i++) {
    const next = items[(((current + step * i) % n) + n) % n]!;
    if (unreadOnly && !next.hasAttribute('data-unread')) continue;
    next.querySelector<HTMLAnchorElement>(':scope > a')!.click();
    return;
  }
}

/** Opens the reactions of the newest message of the channel being read. */
function reactToLast() {
  const log = document.querySelector('main [role="log"]');
  const messages = log?.querySelectorAll('[data-testid="message"]');
  const last = messages?.[messages.length - 1];
  last?.querySelector<HTMLButtonElement>('[data-action="react"]')?.click();
}

/**
 * The app's keyboard shortcuts that work anywhere: the list (Ctrl+/), the
 * details panel (Ctrl+.), moving between channels (Alt+↑↓, unread ones with
 * Shift) and reacting to the newest message (Ctrl+Shift+\).
 */
export function useAppShortcuts() {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.altKey && e.key === '/') {
        e.preventDefault();
        useShortcutsDialog.getState().setOpen(!useShortcutsDialog.getState().open);
      } else if (mod && !e.shiftKey && e.key === '.') {
        e.preventDefault();
        const layout = useLayout.getState();
        layout.setDetailsOpen(!layout.detailsOpen);
      } else if (e.altKey && !mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        moveChannel(e.key === 'ArrowUp' ? -1 : 1, e.shiftKey);
      } else if (mod && e.shiftKey && (e.key === '\\' || e.key === '|' || e.code === 'Backslash')) {
        e.preventDefault();
        reactToLast();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

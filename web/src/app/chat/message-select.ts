// SPDX-License-Identifier: AGPL-3.0-only
import { create } from 'zustand';

/**
 * On touch screens a message's actions show only once it is tapped: one
 * message at a time, a second tap on it closes them. Pointers keep hover.
 */
export const useSelectedMessage = create<{ id: string | null }>()(() => ({ id: null }));

const coarse = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true;

/** Tapping a message (not one of its links or buttons) selects it. */
export function selectOnTap(event: { target: EventTarget | null }, id: string): void {
  if (!coarse()) return;
  const target = event.target as Element | null;
  if (
    target?.closest(
      'a, button, input, textarea, select, summary, video, audio, [role="button"], [contenteditable="true"]',
    )
  )
    return;
  useSelectedMessage.setState((s) => ({ id: s.id === id ? null : id }));
}

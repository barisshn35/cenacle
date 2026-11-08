// SPDX-License-Identifier: AGPL-3.0-only
import { create } from 'zustand';

/**
 * On touch screens a message's actions show only once it is tapped: one
 * message at a time, a second tap on it closes them. Pointers keep hover.
 */
export const useSelectedMessage = create<{ id: string | null }>()(() => ({ id: null }));

const coarse = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true;

/** Whether a click landed on one of a message's own controls (a link, a button, a player…). */
export function onControl(target: EventTarget | null): boolean {
  return !!(target as Element | null)?.closest?.(
    'a, button, input, textarea, select, summary, video, audio, [role="button"], [contenteditable="true"]',
  );
}

/** Tapping a message (not one of its links or buttons) selects it. */
export function selectOnTap(event: { target: EventTarget | null }, id: string): boolean {
  if (!coarse()) return false;
  if (onControl(event.target)) return true;
  useSelectedMessage.setState((s) => ({ id: s.id === id ? null : id }));
  return true;
}

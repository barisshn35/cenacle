// SPDX-License-Identifier: AGPL-3.0-only
import { create } from 'zustand';
import type { Message } from './data';

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

/** How many messages can be picked to forward together. */
export const MAX_PICKED = 10;

/**
 * Picking messages of a channel (to forward several at once): the channel and
 * the picked messages in the order they were picked.
 */
export const usePicking = create<{ channelId: string | null; picked: Message[] }>()(() => ({
  channelId: null,
  picked: [],
}));

export const startPicking = (channelId: string, first: Message) =>
  usePicking.setState({ channelId, picked: [first] });

export const stopPicking = () => usePicking.setState({ channelId: null, picked: [] });

/** Picks the message or puts it back; past the limit nothing is added (false). */
export function togglePicked(m: Message): boolean {
  const { picked } = usePicking.getState();
  if (picked.some((p) => p.id === m.id)) {
    usePicking.setState({ picked: picked.filter((p) => p.id !== m.id) });
    return true;
  }
  if (picked.length >= MAX_PICKED) return false;
  usePicking.setState({ picked: [...picked, m] });
  return true;
}

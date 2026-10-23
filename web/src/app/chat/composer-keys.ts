// SPDX-License-Identifier: AGPL-3.0-only
import type { Message } from './data';

/** Markdown around the selection for the composer's formatting keys. */
export const FORMAT_KEYS: { key: string; shift: boolean; marker: string }[] = [
  { key: 'b', shift: false, marker: '**' },
  { key: 'i', shift: false, marker: '_' },
  { key: 'x', shift: true, marker: '~~' },
  { key: 'e', shift: false, marker: '`' },
];

/**
 * Puts a marker around the selected text, or takes it away when it is there
 * already; without a selection the caret goes between the two markers.
 */
export function wrapSelection(
  value: string,
  start: number,
  end: number,
  marker: string,
): { value: string; start: number; end: number } {
  const selected = value.slice(start, end);
  const before = value.slice(0, start);
  const after = value.slice(end);
  if (before.endsWith(marker) && after.startsWith(marker)) {
    return {
      value: before.slice(0, -marker.length) + selected + after.slice(marker.length),
      start: start - marker.length,
      end: end - marker.length,
    };
  }
  return {
    value: before + marker + selected + marker + after,
    start: start + marker.length,
    end: end + marker.length,
  };
}

/** The newest message of the person that they can still edit. */
export function newestOwn(messages: Message[], selfId: string): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.author.id === selfId && !m.burn && !m.sticker && m.body) return m;
  }
  return undefined;
}

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

/**
 * Starts each selected line with a prefix ("> ", "- ", "1. "), or takes it
 * away when every line has it; numbered lists count up.
 */
export function prefixLines(
  value: string,
  start: number,
  end: number,
  prefix: '> ' | '- ' | '1. ',
): { value: string; start: number; end: number } {
  const from = value.lastIndexOf('\n', start - 1) + 1;
  const toBreak = value.indexOf('\n', end);
  const to = toBreak === -1 ? value.length : toBreak;
  const lines = value.slice(from, to).split('\n');
  const marker = prefix === '1. ' ? /^\d+\. / : new RegExp(`^${prefix.replace(/[.>-]/g, '\\$&')}`);
  const all = lines.every((l) => marker.test(l));
  const changed = lines.map((l, i) =>
    all ? l.replace(marker, '') : (prefix === '1. ' ? `${i + 1}. ` : prefix) + l,
  );
  const block = changed.join('\n');
  return {
    value: value.slice(0, from) + block + value.slice(to),
    start: from,
    end: from + block.length,
  };
}

/** Makes the selection a link; the address placeholder is selected for typing over. */
export function linkSelection(
  value: string,
  start: number,
  end: number,
  placeholder = 'https://',
): { value: string; start: number; end: number } {
  const text = value.slice(start, end) || 'link';
  const inserted = `[${text}](${placeholder})`;
  const at = start + text.length + 3;
  return {
    value: value.slice(0, start) + inserted + value.slice(end),
    start: at,
    end: at + placeholder.length,
  };
}

/** Puts the selected lines in a fenced code block. */
export function codeBlock(
  value: string,
  start: number,
  end: number,
): { value: string; start: number; end: number } {
  const selected = value.slice(start, end);
  const before = start > 0 && value[start - 1] !== '\n' ? '\n' : '';
  const block = `${before}\`\`\`\n${selected}\n\`\`\`\n`;
  const at = start + before.length + 4;
  return {
    value: value.slice(0, start) + block + value.slice(end),
    start: at,
    end: at + selected.length,
  };
}

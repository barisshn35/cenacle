// SPDX-License-Identifier: AGPL-3.0-only
import { MENTION_SECRET } from './mentions';

/**
 * Custom emoji (:name:) and mentions of many (@channel, @here, @admins)
 * become links with a fragment that only this page load makes, like person
 * mentions: a typed look-alike stays text.
 */
const EMOJI = /:([a-z0-9_+-]{2,32}):/g;
const BROADCAST = /(^|[^\w@])@(channel|everyone|here|admins|owners)\b/gi;
// Code (fenced or inline) is left as it is.
const CODE = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/;

/** The kind of a broadcast word as the server names it. */
export const broadcastKind = (word: string) => {
  const w = word.toLowerCase();
  return w === 'everyone'
    ? 'channel'
    : w === 'admins'
      ? 'role:admin'
      : w === 'owners'
        ? 'role:owner'
        : w;
};

export function toMarkdownExtras(
  body: string,
  emoji: ReadonlySet<string>,
  broadcast: readonly string[],
): string {
  if (emoji.size === 0 && broadcast.length === 0) return body;
  return body
    .split(CODE)
    .map((part, i) => {
      if (i % 2 === 1) return part; // a code part
      let out = part;
      if (emoji.size > 0) {
        out = out.replace(EMOJI, (match, name: string) =>
          emoji.has(name) ? `[:${name}:](#emoji-${name}-${MENTION_SECRET})` : match,
        );
      }
      if (broadcast.length > 0) {
        out = out.replace(BROADCAST, (match, before: string, word: string) =>
          broadcast.includes(broadcastKind(word))
            ? `${before}[@${word}](#broadcast-${word.toLowerCase()}-${MENTION_SECRET})`
            : match,
        );
      }
      return out;
    })
    .join('');
}

/** The emoji name of a link made by toMarkdownExtras, if href is one. */
export function emojiLink(href: string | undefined): string | undefined {
  const m = /^#(?:user-content-)?emoji-([a-z0-9_+-]{2,32})-([0-9a-f]{32})$/.exec(href ?? '');
  return m && m[2] === MENTION_SECRET ? m[1] : undefined;
}

/** The broadcast word of a link made by toMarkdownExtras, if href is one. */
export function broadcastLink(href: string | undefined): string | undefined {
  const m = /^#(?:user-content-)?broadcast-([a-z]+)-([0-9a-f]{32})$/.exec(href ?? '');
  return m && m[2] === MENTION_SECRET ? m[1] : undefined;
}

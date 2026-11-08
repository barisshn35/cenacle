// SPDX-License-Identifier: AGPL-3.0-only
import { MENTION_SECRET } from './mentions';

/**
 * Custom emoji (:name:), mentions of many (@channel, @here, @admins) and
 * group mentions (@backend) become links with a fragment that only this page
 * load makes, like person mentions: a typed look-alike stays text.
 */
const EMOJI = /:([a-z0-9_+-]{2,32}):/g;
const BROADCAST = /(^|[^\w@])@(channel|everyone|all|kanal|herkes|here|burada|admins|owners)\b/gi;
// Code (fenced or inline) is left as it is.
const CODE = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/;

/** The kind of a broadcast word as the server names it. */
export const broadcastKind = (word: string) => {
  const w = word.toLowerCase();
  return w === 'everyone' || w === 'all' || w === 'kanal' || w === 'herkes'
    ? 'channel'
    : w === 'burada'
      ? 'here'
      : w === 'admins'
        ? 'role:admin'
        : w === 'owners'
          ? 'role:owner'
          : w;
};

// A group mention: @handle, not inside a word, an address or <@id>.
const GROUP = /(^|[^\w@<[])@([a-z0-9](?:[a-z0-9._-]{0,28}[a-z0-9])?)/gi;

export function toMarkdownExtras(
  body: string,
  emoji: ReadonlySet<string>,
  broadcast: readonly string[],
  groups: ReadonlySet<string> = new Set(),
): string {
  if (emoji.size === 0 && broadcast.length === 0 && groups.size === 0) return body;
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
      if (groups.size > 0) {
        out = out.replace(GROUP, (match, before: string, handle: string) =>
          groups.has(handle.toLowerCase())
            ? `${before}[@${handle}](#group-${handle.toLowerCase()}-${MENTION_SECRET})`
            : match,
        );
      }
      return out;
    })
    .join('');
}

/** The group handle of a link made by toMarkdownExtras, if href is one. */
export function groupLink(href: string | undefined): string | undefined {
  const m = /^#(?:user-content-)?group-([a-z0-9._-]{1,30})-([0-9a-f]{32})$/.exec(href ?? '');
  return m && m[2] === MENTION_SECRET ? m[1] : undefined;
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

/** At most this many emoji make a message shown large. */
export const JUMBO_MAX = 10;
const PICTOGRAPH = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * Whether a message is only emoji (the workspace's and standard ones, at most
 * JUMBO_MAX), so it is shown large, as people send emotes.
 */
export function onlyEmoji(body: string, emoji: ReadonlySet<string>): boolean {
  let count = 0;
  const rest = body.replace(EMOJI, (match, name: string) => {
    if (!emoji.has(name)) return match;
    count++;
    return ' ';
  });
  for (const { segment } of graphemes.segment(rest)) {
    if (/^\s+$/.test(segment)) continue;
    if (!PICTOGRAPH.test(segment)) return false;
    count++;
  }
  return count > 0 && count <= JUMBO_MAX;
}

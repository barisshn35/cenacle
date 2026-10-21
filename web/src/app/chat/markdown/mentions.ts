// SPDX-License-Identifier: Apache-2.0

/** How a body mentions someone: <@user-id>. */
export const MENTION_PATTERN =
  /<@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/gi;

/** Mentions become links with this fragment in Markdown (sanitizing prefixes it). */
export const MENTION_PREFIX = 'mention-';

type Person = { id: string; display_name: string };

const escapeLabel = (s: string) => s.replace(/[[\]\\]/g, '\\$&');

/** <@id> → [@Name](#mention-id), so Markdown keeps it as one link. */
export function toMarkdownMentions(body: string, people: Person[]): string {
  return body.replace(MENTION_PATTERN, (_, id: string) => {
    const name = people.find((p) => p.id === id.toLowerCase())?.display_name ?? '…';
    return `[@${escapeLabel(name)}](#${MENTION_PREFIX}${id.toLowerCase()})`;
  });
}

/** <@id> → @Name, for editing a message as text. */
export function mentionsToText(body: string, people: Person[]): string {
  return body.replace(MENTION_PATTERN, (match, id: string) => {
    const person = people.find((p) => p.id === id.toLowerCase());
    return person ? `@${person.display_name}` : match;
  });
}

/**
 * @Name → <@id> for the people picked while typing (longest names first, so
 * "@Ayşe Yılmaz" wins over "@Ayşe").
 */
export function textToMentions(text: string, picked: Person[]): string {
  let out = text;
  const byLength = [...picked].sort((a, b) => b.display_name.length - a.display_name.length);
  for (const p of byLength) {
    out = out.split(`@${p.display_name}`).join(`<@${p.id}>`);
  }
  return out;
}

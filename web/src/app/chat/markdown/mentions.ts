// SPDX-License-Identifier: Apache-2.0

/** How a body mentions someone: <@user-id>. */
export const MENTION_PATTERN =
  /<@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/gi;

/** Mentions become links with this fragment in Markdown (sanitizing may prefix it). */
export const MENTION_PREFIX = 'mention-';

/**
 * A secret of this page load in every mention link, so a link typed by a
 * sender ("[@Boss](#mention-…)") can never pass for a mention.
 */
export const MENTION_SECRET = crypto.randomUUID().replace(/-/g, '');

/** The id of a mention link made by toMarkdownMentions, if href is one. */
export function mentionId(href: string | undefined): string | undefined {
  const m = /^#(?:user-content-)?mention-([0-9a-f-]{36})-([0-9a-f]{32})$/.exec(href ?? '');
  return m && m[2] === MENTION_SECRET ? m[1] : undefined;
}

type Person = { id: string; display_name: string };

const escapeLabel = (s: string) => s.replace(/[[\]\\]/g, '\\$&');

/** <@id> → [@Name](#mention-id), so Markdown keeps it as one link. */
export function toMarkdownMentions(body: string, people: Person[]): string {
  return body.replace(MENTION_PATTERN, (_, id: string) => {
    const person = people.find((p) => p.id === id.toLowerCase());
    // Someone who is not mentioned (no longer a member) shows as plain text.
    if (!person) return '@…';
    return `[@${escapeLabel(person.display_name)}](#${MENTION_PREFIX}${id.toLowerCase()}-${MENTION_SECRET})`;
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

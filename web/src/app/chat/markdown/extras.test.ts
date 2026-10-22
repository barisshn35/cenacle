// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { broadcastKind, broadcastLink, emojiLink, toMarkdownExtras } from './extras';
import { MENTION_SECRET } from './mentions';

const emoji = new Set(['party', 'ship_it']);

describe('toMarkdownExtras', () => {
  it('turns known custom emoji into links only this page makes', () => {
    const out = toMarkdownExtras('so :party: and :unknown:', emoji, []);
    expect(out).toBe(`so [:party:](#emoji-party-${MENTION_SECRET}) and :unknown:`);
    expect(emojiLink(`#user-content-emoji-party-${MENTION_SECRET}`)).toBe('party');
    expect(emojiLink(`#emoji-party-${'0'.repeat(32)}`)).toBeUndefined();
  });

  it('leaves code alone', () => {
    const body = 'use `:party:` or\n```\n:party: @here\n```\n:ship_it:';
    const out = toMarkdownExtras(body, emoji, ['here']);
    expect(out).toContain('`:party:`');
    expect(out).toContain('\n:party: @here\n');
    expect(out).toContain(`[:ship_it:](#emoji-ship_it-${MENTION_SECRET})`);
  });

  it('marks only the mentions of many the server recorded', () => {
    const out = toMarkdownExtras('@here and @channel, mail@here.com', new Set(), ['here']);
    expect(out).toBe(`[@here](#broadcast-here-${MENTION_SECRET}) and @channel, mail@here.com`);
    expect(broadcastLink(`#broadcast-here-${MENTION_SECRET}`)).toBe('here');
  });

  it('names broadcast words as the server does', () => {
    expect(broadcastKind('Everyone')).toBe('channel');
    expect(broadcastKind('admins')).toBe('role:admin');
    expect(broadcastKind('owners')).toBe('role:owner');
    expect(broadcastKind('here')).toBe('here');
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type { Category, Channel } from '../chat/data';
import {
  addSection,
  arrange,
  emptyLayout,
  moveSection,
  place,
  removeSection,
  type SidebarLayout,
} from './sidebar-layout';

const ch = (id: string, extra: Partial<Channel> = {}): Channel =>
  ({
    id,
    name: id,
    kind: 'public',
    workspace_id: 'w',
    unread_count: 0,
    mention_count: 0,
    category_id: null,
    participants: [],
    ...extra,
  }) as unknown as Channel;
const cat = (id: string, name: string) => ({ id, name }) as Category;
const keys = (
  l: SidebarLayout,
  channels: Channel[],
  cats: Category[] = [],
  muted = new Set<string>(),
) =>
  arrange(l, channels, cats, muted).map((s) => `${s.key}:${s.channels.map((c) => c.id).join(',')}`);

describe('sidebar arrangement', () => {
  const general = ch('general');
  const ops = ch('ops', { category_id: 'cat1' });
  const dm = ch('dm', { kind: 'direct' });

  it('keeps the usual sections when nothing was changed', () => {
    expect(keys(emptyLayout(), [general, ops, dm], [cat('cat1', 'Ops')])).toEqual([
      'channels:general',
      'cat1:ops',
      'direct:dm',
    ]);
  });

  it('puts placed channels in Favorites and own sections, in the chosen order', () => {
    let l = place(emptyLayout(), 'ops', 'favorites');
    l = addSection(l, arrange(l, [general, ops, dm], [], new Set()), 'Team', 's1');
    l = place(l, 'dm', 's1');
    expect(keys(l, [general, ops, dm], [cat('cat1', 'Ops')])).toEqual([
      'favorites:ops',
      's1:dm',
      'channels:general',
      'direct:',
    ]);
    l = { ...l, order: moveSection(l.order, 'direct', 0) };
    expect(keys(l, [general, ops, dm])[0]).toBe('direct:');
  });

  it('gathers unread ones at the top, keeping muted ones out unless mentioned', () => {
    const busy = ch('busy', { unread_count: 3 });
    const quiet = ch('quiet', { unread_count: 2 });
    const l = { ...emptyLayout(), group_unreads: true };
    expect(keys(l, [general, busy, quiet], [], new Set(['quiet']))).toEqual([
      'unreads:busy',
      'channels:general,quiet',
      'direct:',
    ]);
  });

  it('sends channels back home when their section is removed or unknown', () => {
    let l = { ...emptyLayout(), sections: [{ id: 's1', name: 'Team' }] };
    l = place(l, 'general', 's1');
    l = removeSection(l, 's1');
    expect(l.placements).toEqual({});
    expect(keys(place(emptyLayout(), 'general', 'gone'), [general])).toEqual([
      'channels:general',
      'direct:',
    ]);
  });
});

// SPDX-License-Identifier: Apache-2.0
import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { addMessage, flatten, reloadMessages, type Message, type MessagePage } from './data';

const msg = (id: string): Message => ({
  id,
  channel_id: 'c1',
  author: { id: 'u1', display_name: 'Ayşe' },
  body: id,
  nonce: `n-${id}`,
  created_at: '2026-10-21T09:00:00Z',
});

const data = (...pages: string[][]): InfiniteData<MessagePage, string | undefined> => ({
  pages: pages.map((ids) => ({ messages: ids.map(msg), has_more: true })),
  pageParams: pages.map((_, i) => (i === 0 ? undefined : `cursor-${i}`)),
});

describe('message cache', () => {
  it('flattens pages oldest first without duplicates', () => {
    // Page 0 is the newest; an older page may overlap it after a refetch.
    expect(flatten(data(['03', '04'], ['02', '03'])).map((m) => m.id)).toEqual(['02', '03', '04']);
  });

  it('adds live messages once, in order', () => {
    const qc = new QueryClient();
    qc.setQueryData(['messages', 'c1'], data(['01', '03']));
    addMessage(qc, msg('04'));
    addMessage(qc, msg('02'));
    addMessage(qc, msg('04'));
    const ids = flatten(qc.getQueryData(['messages', 'c1'])).map((m) => m.id);
    expect(ids).toEqual(['01', '02', '03', '04']);
    // Channels that were never opened are left alone.
    addMessage(qc, { ...msg('05'), channel_id: 'c2' });
    expect(qc.getQueryData(['messages', 'c2'])).toBeUndefined();
  });

  it('drops older pages before reloading', async () => {
    const qc = new QueryClient();
    qc.setQueryData(['messages', 'c1'], data(['03', '04'], ['01', '02']));
    await reloadMessages(qc);
    const after = qc.getQueryData<InfiniteData<MessagePage>>(['messages', 'c1'])!;
    expect(after.pages).toHaveLength(1);
    expect(after.pageParams).toEqual([undefined]);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
import { QueryClient } from '@tanstack/react-query';
import { calls, type Call } from '@cenacle/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyCallEvent, channelCallQuery } from './state';

const call = {
  id: 'call-1',
  channel_id: 'channel-1',
  revision: 1,
  state: 'active',
  created_at: '2026-11-06T10:00:00Z',
  participants: [],
} as unknown as Call;

afterEach(() => vi.restoreAllMocks());

describe('channelCallQuery', () => {
  it('keeps a live call that arrived while an older fetch was answering', async () => {
    let answer!: (value: Call | null) => void;
    vi.spyOn(calls, 'current').mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const client = new QueryClient();
    const fetching = client.fetchQuery(channelCallQuery('channel-1'));
    applyCallEvent(client, 'call.started', call, 'self');
    answer(null); // the fetch started before the call
    await fetching;
    expect(client.getQueryData(channelCallQuery('channel-1').queryKey)).toEqual(call);
  });

  it('uses a fetch that started after the last event', async () => {
    applyCallEvent(new QueryClient(), 'call.started', { ...call, channel_id: 'channel-2' }, 'self');
    vi.spyOn(calls, 'current').mockResolvedValue(null);
    const client = new QueryClient();
    expect(await client.fetchQuery(channelCallQuery('channel-2'))).toBeNull();
  });
});

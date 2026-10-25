// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api';
import {
  CLOSE_SESSION_ENDED,
  RealtimeClient,
  type ConnectionStatus,
  type Environment,
  type RealtimeEvent,
} from '../src/realtime';

class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  close() {
    this.closed = true;
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  drop(code = 1006) {
    this.onclose?.({ code });
  }
}

const last = () => FakeSocket.all[FakeSocket.all.length - 1]!;

function fakeEnv() {
  const listeners: Record<string, (() => void)[]> = {};
  let online = true;
  const env: Environment = {
    on(event, fn) {
      (listeners[event] ??= []).push(fn);
      return () => (listeners[event] = listeners[event]!.filter((f) => f !== fn));
    },
    isOnline: () => online,
  };
  return {
    env,
    fire(event: string, isOnline = online) {
      online = isOnline;
      for (const fn of listeners[event] ?? []) fn();
    },
    count: (event: string) => (listeners[event] ?? []).length,
  };
}

function setup(getTicket = vi.fn().mockResolvedValue('t1')) {
  const events: RealtimeEvent[] = [];
  const statuses: ConnectionStatus[] = [];
  const onResync = vi.fn();
  const onUnauthenticated = vi.fn();
  const browser = fakeEnv();
  const client = new RealtimeClient(
    {
      onEvent: (e) => events.push(e),
      onResync,
      onStatus: (s) => statuses.push(s),
      onUnauthenticated,
    },
    {
      getTicket,
      url: (t, id) => `ws://test/ws?ticket=${t}${id ? `&last_event_id=${id}` : ''}`,
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      random: () => 1,
      minDelay: 100,
      maxDelay: 1000,
      environment: browser.env,
    },
  );
  return { client, events, statuses, onResync, onUnauthenticated, getTicket, browser };
}

beforeEach(() => {
  FakeSocket.all = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('RealtimeClient', () => {
  it('connects with a ticket, delivers events and resyncs after the first hello', async () => {
    const { client, events, statuses, onResync } = setup();
    client.start();
    await vi.runAllTimersAsync();
    expect(last().url).toBe('ws://test/ws?ticket=t1');
    last().receive({ op: 'hello', last_event_id: '5-0', heartbeat_ms: 25000 });
    expect(onResync).toHaveBeenCalledTimes(1);
    last().receive({ op: 'event', id: '6-0', type: 'message.created', data: { id: 'm1' } });
    expect(events).toEqual([{ id: '6-0', type: 'message.created', data: { id: 'm1' } }]);
    expect(statuses).toEqual(['connecting', 'open']);
    client.stop();
  });

  it('hands short-lived notices over without moving the resume position', async () => {
    const onEphemeral = vi.fn();
    const client = new RealtimeClient(
      { onEvent: () => {}, onResync: () => {}, onEphemeral },
      {
        getTicket: vi.fn().mockResolvedValue('t'),
        url: (t, id) => `ws://test/ws?ticket=${t}${id ? `&last_event_id=${id}` : ''}`,
        WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
        random: () => 1,
        minDelay: 100,
        environment: fakeEnv().env,
      },
    );
    client.start();
    await vi.runAllTimersAsync();
    last().receive({ op: 'hello', last_event_id: '5-0', heartbeat_ms: 1 });
    last().receive({ op: 'ephemeral', type: 'typing', data: { user_id: 'u' } });
    expect(onEphemeral).toHaveBeenCalledWith({ type: 'typing', data: { user_id: 'u' } });
    last().drop();
    await vi.advanceTimersByTimeAsync(100);
    expect(last().url).toBe('ws://test/ws?ticket=t&last_event_id=5-0');
    client.stop();
  });

  it('resumes after the last event with growing, capped delays', async () => {
    const getTicket = vi.fn().mockResolvedValueOnce('t1').mockResolvedValue('t2');
    const { client, onResync, statuses } = setup(getTicket);
    client.start();
    await vi.runAllTimersAsync();
    last().receive({ op: 'hello', last_event_id: '5-0', heartbeat_ms: 1 });
    last().receive({ op: 'event', id: '7-0', type: 'x', data: null });

    last().drop();
    expect(statuses.at(-1)).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(99);
    expect(FakeSocket.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(last().url).toBe('ws://test/ws?ticket=t2&last_event_id=7-0');
    // A resumed connection does not resync by itself...
    last().receive({ op: 'hello', last_event_id: '7-0', heartbeat_ms: 1 });
    expect(onResync).toHaveBeenCalledTimes(1);
    // ...only when the server says so.
    last().receive({ op: 'resync' });
    expect(onResync).toHaveBeenCalledTimes(2);

    // Ticket failures back off: 100, 200, 400, 800, then 1000 ms (cap).
    getTicket.mockRejectedValue(
      new ApiError({ type: 'about:blank', title: '', status: 503, code: 'x' }),
    );
    last().drop();
    for (const delay of [100, 200, 400, 800, 1000, 1000]) {
      const before = getTicket.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(getTicket.mock.calls.length).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(getTicket.mock.calls.length).toBe(before + 1);
    }
    client.stop();
  });

  it('keeps its resume position until the events or the resync after hello arrive', async () => {
    const { client } = setup(vi.fn().mockResolvedValue('t'));
    client.start();
    await vi.runAllTimersAsync();
    last().receive({ op: 'hello', last_event_id: '5-0', heartbeat_ms: 25000 });
    last().drop();
    await vi.advanceTimersByTimeAsync(100);
    // The server's log has moved on to 9-0; the connection drops before its resync.
    last().receive({ op: 'hello', last_event_id: '9-0', heartbeat_ms: 25000 });
    last().drop();
    await vi.advanceTimersByTimeAsync(100);
    expect(last().url).toBe('ws://test/ws?ticket=t&last_event_id=5-0');
    last().receive({ op: 'hello', last_event_id: '9-0', heartbeat_ms: 25000 });
    last().receive({ op: 'resync' });
    last().drop();
    await vi.advanceTimersByTimeAsync(100);
    expect(last().url).toBe('ws://test/ws?ticket=t&last_event_id=9-0');
    client.stop();
  });

  it('reconnects when the server falls silent for two heartbeats', async () => {
    const { client } = setup(vi.fn().mockResolvedValue('t'));
    client.start();
    await vi.runAllTimersAsync();
    last().receive({ op: 'hello', last_event_id: '1-0', heartbeat_ms: 25000 });
    await vi.advanceTimersByTimeAsync(50_000);
    last().receive({ op: 'ping' }); // still there
    await vi.advanceTimersByTimeAsync(54_000);
    expect(FakeSocket.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(FakeSocket.all[0]!.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(FakeSocket.all).toHaveLength(2);
    client.stop();
  });

  it('stops when the session has ended', async () => {
    const { client, onUnauthenticated } = setup();
    client.start();
    await vi.runAllTimersAsync();
    last().drop(CLOSE_SESSION_ENDED);
    expect(onUnauthenticated).toHaveBeenCalledOnce();
    expect(client.connectionStatus).toBe('stopped');
    await vi.runAllTimersAsync();
    expect(FakeSocket.all).toHaveLength(1);

    const signedOut = setup(
      vi
        .fn()
        .mockRejectedValue(
          new ApiError({ type: 'about:blank', title: '', status: 401, code: 'unauthenticated' }),
        ),
    );
    signedOut.client.start();
    await vi.runAllTimersAsync();
    expect(signedOut.onUnauthenticated).toHaveBeenCalledOnce();
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('waits while offline and reconnects at once when back online', async () => {
    const { client, statuses, browser } = setup();
    client.start();
    await vi.runAllTimersAsync();
    last().receive({ op: 'hello', last_event_id: '1-0', heartbeat_ms: 1 });

    browser.fire('offline', false);
    expect(last().closed).toBe(true);
    expect(statuses.at(-1)).toBe('offline');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.all).toHaveLength(1);

    browser.fire('online', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.all).toHaveLength(2);
    expect(last().url).toContain('last_event_id=1-0');

    client.stop();
    expect(browser.count('online')).toBe(0);
  });
});

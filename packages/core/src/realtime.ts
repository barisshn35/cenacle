// SPDX-License-Identifier: Apache-2.0
import { ApiError, apiFetch, isUnauthenticated } from './api';

/** Connection state shown to the user. */
export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'offline' | 'stopped';

/** One event of the chat server's live stream. */
export interface RealtimeEvent {
  id: string;
  type: string;
  data: unknown;
}

type Frame =
  | { op: 'hello'; last_event_id: string; heartbeat_ms: number }
  | { op: 'event'; id: string; type: string; data: unknown }
  | { op: 'resync' };

/** Close codes of the server (see the API spec). */
export const CLOSE_INVALID_TICKET = 4001;
export const CLOSE_SESSION_ENDED = 4003;
export const CLOSE_TOO_SLOW = 4008;

export interface RealtimeHandlers {
  /** An event, in order, exactly once per connection. */
  onEvent(event: RealtimeEvent): void;
  /** Events may have been missed: reload data from the API. */
  onResync(): void;
  onStatus?(status: ConnectionStatus): void;
  /** The session has ended; the client stops. */
  onUnauthenticated?(): void;
}

export interface RealtimeOptions {
  /** Returns a WebSocket ticket (default: POST /api/ws/ticket). */
  getTicket?: () => Promise<string>;
  /** WebSocket URL for a ticket (default: /ws on the page's origin). */
  url?: (ticket: string, lastEventId: string | undefined) => string;
  /** For tests. */
  WebSocketImpl?: typeof WebSocket;
  random?: () => number;
  /** Reconnect delays: exponential with full jitter between these bounds (ms). */
  minDelay?: number;
  maxDelay?: number;
  /** Online/offline and tab visibility (default: the browser's). */
  environment?: Environment;
}

/** What the client needs from the browser. */
export interface Environment {
  /** Events: "online", "offline" and "visible". */
  on(event: 'online' | 'offline' | 'visible', fn: () => void): () => void;
  isOnline(): boolean;
}

function browserEnvironment(): Environment | undefined {
  if (typeof window === 'undefined') return undefined;
  return {
    on(event, fn) {
      if (event === 'visible') {
        const listener = () => document.visibilityState === 'visible' && fn();
        document.addEventListener('visibilitychange', listener);
        return () => document.removeEventListener('visibilitychange', listener);
      }
      window.addEventListener(event, fn);
      return () => window.removeEventListener(event, fn);
    },
    isOnline: () => navigator.onLine,
  };
}

async function defaultTicket(): Promise<string> {
  const res = await apiFetch<{ ticket: string }>('/api/ws/ticket', { method: 'POST' });
  return res.ticket;
}

function defaultUrl(ticket: string, lastEventId: string | undefined): string {
  const q = new URLSearchParams({ ticket });
  if (lastEventId) q.set('last_event_id', lastEventId);
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws?${q.toString()}`;
}

/**
 * Keeps one WebSocket to the chat server open: fetches a ticket, resumes
 * after the last event it saw, reconnects with backoff (immediately when the
 * device comes back online or the tab becomes visible), and asks the app to
 * reload when events were missed.
 */
export class RealtimeClient {
  private readonly opts: Required<Omit<RealtimeOptions, 'environment'>> &
    Pick<RealtimeOptions, 'environment'>;
  private socket: WebSocket | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private lastEventId: string | undefined;
  private status: ConnectionStatus = 'stopped';
  private generation = 0;
  private unlisten: (() => void)[] = [];
  /** A ticket request is in flight. */
  private pending = false;

  constructor(
    private readonly handlers: RealtimeHandlers,
    options: RealtimeOptions = {},
  ) {
    this.opts = {
      getTicket: options.getTicket ?? defaultTicket,
      url: options.url ?? defaultUrl,
      WebSocketImpl: options.WebSocketImpl ?? WebSocket,
      random: options.random ?? Math.random,
      minDelay: options.minDelay ?? 500,
      maxDelay: options.maxDelay ?? 30_000,
      environment: options.environment ?? browserEnvironment(),
    };
  }

  get connectionStatus(): ConnectionStatus {
    return this.status;
  }

  start(): void {
    if (this.status !== 'stopped') return;
    const env = this.opts.environment;
    if (env) {
      this.unlisten = [
        env.on('online', () => this.reconnectNow()),
        env.on('offline', () => this.goOffline()),
        env.on('visible', () => this.reconnectNow()),
      ];
    }
    this.setStatus('connecting');
    void this.connect();
  }

  stop(): void {
    this.generation++;
    for (const off of this.unlisten) off();
    this.unlisten = [];
    clearTimeout(this.timer);
    this.closeSocket();
    this.setStatus('stopped');
  }

  private setStatus(s: ConnectionStatus) {
    if (s === this.status) return;
    this.status = s;
    this.handlers.onStatus?.(s);
  }

  private closeSocket() {
    const s = this.socket;
    this.socket = undefined;
    if (s) {
      s.onopen = s.onmessage = s.onclose = s.onerror = null;
      s.close(1000);
    }
  }

  private goOffline() {
    if (this.status === 'stopped') return;
    clearTimeout(this.timer);
    this.closeSocket();
    this.setStatus('offline');
  }

  /** Connects at once unless connected (back online, tab visible again). */
  private reconnectNow() {
    if (this.status === 'stopped' || this.socket || this.pending) return;
    clearTimeout(this.timer);
    this.attempt = 0;
    this.setStatus('reconnecting');
    void this.connect();
  }

  private schedule() {
    if (this.status === 'stopped') return;
    if (this.opts.environment && !this.opts.environment.isOnline()) {
      this.setStatus('offline'); // the "online" event reconnects
      return;
    }
    this.setStatus('reconnecting');
    const ceiling = Math.min(this.opts.maxDelay, this.opts.minDelay * 2 ** this.attempt);
    this.attempt++;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.connect(), Math.round(this.opts.random() * ceiling));
  }

  private async connect() {
    const generation = this.generation;
    let ticket: string;
    this.pending = true;
    try {
      ticket = await this.opts.getTicket();
    } catch (err) {
      this.pending = false;
      if (generation !== this.generation) return;
      if (isUnauthenticated(err)) {
        this.stop();
        this.handlers.onUnauthenticated?.();
        return;
      }
      if (!(err instanceof ApiError)) console.warn('realtime: ticket failed', err);
      this.schedule();
      return;
    }
    this.pending = false;
    if (generation !== this.generation || this.status === 'stopped') return;

    const socket = new this.opts.WebSocketImpl(this.opts.url(ticket, this.lastEventId));
    this.socket = socket;
    const resuming = this.lastEventId !== undefined;
    socket.onmessage = (msg) => {
      let frame: Frame;
      try {
        frame = JSON.parse(String(msg.data)) as Frame;
      } catch {
        return;
      }
      switch (frame.op) {
        case 'hello':
          this.lastEventId = frame.last_event_id;
          this.attempt = 0;
          this.setStatus('open');
          // Without a position to resume from, anything since the app loaded
          // its data may be missing.
          if (!resuming) this.handlers.onResync();
          break;
        case 'event':
          this.lastEventId = frame.id;
          this.handlers.onEvent({ id: frame.id, type: frame.type, data: frame.data });
          break;
        case 'resync':
          this.handlers.onResync();
          break;
      }
    };
    socket.onclose = (ev) => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      if (ev.code === CLOSE_SESSION_ENDED) {
        this.stop();
        this.handlers.onUnauthenticated?.();
        return;
      }
      this.schedule();
    };
  }
}

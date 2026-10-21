# 0005. Live chat: messages, event stream and WebSocket (v0.4)

- Status: accepted
- Date: 2026-10-21

## Context

v0.4 makes the chat live: people send messages to a channel and everyone sees them at
once, on any server instance. The kickoff fixes raw WebSocket with an own JSON envelope
(`coder/websocket`), single-use tickets from `POST /ws/ticket` stored in Valkey (`GETDEL`),
resuming with `last_event_id`, a `resync` when the gap is too large, and a bounded send
queue per connection. Channels, categories and workspaces come in v0.5 and v0.6; Markdown
and the transactional outbox in v0.9.

## Decisions

1. **Minimal channel model.** `channels(id, name, topic)` with one `#general` created by
   the migration. Until workspaces and roles (v0.6) every signed-in user reads and writes
   every channel. Messages: `uuidv7` ids (time-ordered), `(channel_id, id DESC)` index,
   body as typed (Markdown source, never HTML), up to 4000 characters.
2. **Cursor pagination over ids.** `GET /api/channels/{id}/messages?before=<id>&limit=`
   returns the newest page first; each page is chronological with `has_more`. No
   `OFFSET`.
3. **Idempotent sending.** The client chooses a nonce per message; `(author_id, nonce)` is
   unique. A retry after a lost response returns the stored message instead of a second
   copy. The nonce is part of the message, so the sender can replace its pending copy.
4. **Rate limit.** 20 messages per 10 seconds per user (Valkey fixed window), answered with
   `429`, `Retry-After` and the problem code `rate_limited`.
5. **Event log: one Valkey stream.** Every instance appends events (`XADD`, about the last
   10,000 kept) and follows the stream (`XREAD BLOCK`), handing events to its own
   connections. Stream ids are the event ids clients resume from. This needs no
   coordination between instances, survives an instance restart and keeps ordering. One
   stream for everything is enough until load tests (v0.13) say otherwise; it can then be
   split by workspace.
6. **Detecting gaps.** Resuming is allowed when every event after `last_event_id` is still
   in the stream: not when old events were trimmed past it (`recorded-first-entry-id` and
   `entries-added` > `length`, since trimming does not update `max-deleted-entry-id`), when
   the id is newer than the stream (Valkey lost its data), or when more than 500 events
   are missing. Otherwise the client gets `resync` and reloads.
7. **Protocol.** Server to client only, JSON text frames: `hello` (start position,
   heartbeat), `event` (id, type, data), `resync`. Close codes 4001 (ticket), 4003
   (session ended), 4008 (too slow). Clients send nothing; they use the REST API to act.
8. **Connections.** Opened with a ticket valid once for 30 seconds (the session token
   never appears in URLs or logs); only the app origin may connect (cross-site WebSocket
   hijacking). Each connection registers with the hub before reading its backlog and skips
   events it already sent, so nothing falls between backlog and live events. A queue of
   256 events: a client that cannot keep up is closed and resumes. Server pings every 25
   seconds; the session is re-checked every minute and the connection closed when it has
   ended. The HTTP server's read and write timeouts are cleared after the upgrade (Go
   keeps them on hijacked connections).
9. **Delivery is at least once.** A message is stored before its event is appended. If
   the append fails the message is still there, and clients see it when they load the
   channel; the transactional outbox (v0.9) closes this gap. Clients deduplicate by id.
10. **Client.** `RealtimeClient` in `@cenacle/core` reconnects with exponential backoff and
    full jitter (0.5 s to 30 s), immediately when the device comes back online or the tab
    becomes visible, and pauses while offline. Live events update the TanStack Query cache;
    a resync drops older loaded pages (they would overlap the new newest page) and reloads.
11. **Timeline and composer.** `react-virtuoso` (MIT; the commercial message list is not
    used) with `firstItemIndex` for prepending and `followOutput` only when the reader is
    at the bottom. Sending is optimistic; failures stay in place with "Try again" (same
    nonce) and "Discard". Enter sends, Shift+Enter adds a line, nothing is sent while an
    input method composes. Drafts are kept per channel in IndexedDB; what is typed before
    the stored draft arrives wins. The composer is a plain text area until TipTap (v0.9).
12. **Tests.** Go integration tests run two server instances against one database and
    Valkey (fan-out), resume and resync, trimming, single-use tickets, foreign origins,
    session end and the HTTP timeouts; each test gets its own database schema, so packages
    run in parallel. Playwright tests use a fake chat server in the browser
    (`routeWebSocket`); the stack tests have two people chat live, across a lost
    connection.

## Consequences

- Valkey becomes part of message delivery. The production stack runs it with an
  append-only file; if it loses its data anyway, clients resync and nothing stored is lost.
- Events of every channel go to every connection until channel membership exists (v0.6),
  where the hub starts filtering by what a user may read.
- Typing indicators and presence (v0.7) will use Valkey pub/sub, not the stream: they are
  not worth resuming.

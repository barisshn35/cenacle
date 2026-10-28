# 0030. Federation: channels shared between Cenacle servers (v0.25)

- Status: accepted
- Date: 2026-10-23

## Context

Organizations work with partners who run their own Cenacle. They need a channel both sides
use, without accounts on each other's server and without a third party in between.
Cenacle does not bridge to other chat products (decided earlier); it connects to other
Cenacle servers.

## Decisions

1. **Connections** belong to a workspace and are set up by its owners or admins with an
   invitation code: the inviting server makes a code (its address, a one-time token and a
   new secret; valid a day, shown once); the other side's admins paste it, their server
   calls `POST /api/federation/v1/connect` signed with the secret, and both store the
   connection with the same secret and each other's connection id. A connection can be
   paused or removed on either side.
2. **Signed requests.** Every server-to-server request carries
   `X-Cenacle-Federation: c=<receiver's connection id>,t=<time>,v1=<HMAC-SHA256>` (the same
   scheme as bot requests, five minutes of tolerance). Outgoing requests follow the egress
   rules (public `https`, or networks in `CENACLE_EGRESS_ALLOW`).
3. **Sharing** a channel offers it to a connection; the other side's admins accept it as a
   new private channel (named after the server when the name is taken) or decline. Only
   standard and announcement channels are shared, never conversations, forums, archived or
   encrypted channels.
4. **What goes over:** messages (text; mentions become names), replies (in their thread),
   edits, deletions and reactions with emoji, both ways. Files, polls, stickers, forms,
   burn-on-read messages and custom emoji stay on their server. Each side keeps which local
   message is which remote one, so events refer to the receiver's own ids and repeats are
   harmless (posts use the remote id as their nonce).
5. **People of the other server** become guests of the workspace, members of the shared
   channel only, named "Name (Server)". They never sign in. Only the server a message came
   from can edit or delete it.
6. **Delivery** is a transactional outbox: events are queued in the transaction of the
   change, and a periodic job sends each connection's events in order, in batches of 100,
   retrying with backoff up to an hour apart. The order holds across retries and replicas:
   one sender works on a connection at a time (a PostgreSQL advisory lock per connection),
   and while a connection's oldest event waits for its retry, the events queued after it
   wait too (so a deletion or edit never overtakes its message, 0.99.2). The flip side: an
   event the other server keeps refusing holds up the connection, which shows the error on
   both sides until it is fixed or the connection is removed. An event never returns to the
   server it came from, so two servers do not echo; a channel shared with several servers
   relays between them.

## Consequences

- Federation needs both servers to reach each other over the network.
- Removing a connection keeps the messages already exchanged; the remote guests stay as
  authors of old messages.

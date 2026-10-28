# 0047. Allowing older federation signatures after a downgrade (v0.99.3)

- Status: accepted
- Date: 2026-10-28

## Context

Since 0.99.2, servers sign federation requests with `v1` (time and body) and `v2` (also the
connection and the endpoint). Once a connection's server has signed with `v2`, the
connection requires it (`signature_version = 2`), so an attacker who sees a request cannot
strip `v2` and send its `v1` part to another connection or endpoint. A server moved back
below 0.99.2 signs with `v1` only: every request it sends is refused, and as deliveries are
ordered per connection, its queue for us stalls. The 0.99.2 upgrade notes asked for the
connection to be removed and connected again, which unlinks its shared channels and drops
what was queued.

## Decisions

1. **The latch stays.** A connection that requires `v2` keeps refusing requests without it;
   nothing switches back by itself.
2. **A refused `v1`-only request is noted only when its `v1` signature is valid** for the
   connection's secret and time (`federation_connections.v1_refused_at`, written at most
   once a minute). An unsigned or forged request cannot set it. The note only informs the
   workspace's admins; it changes nothing about what is accepted.
3. **Owners and admins of the workspace may allow older signatures again**
   (`POST /api/federation/connections/{id}/accept-v1`, audited as `federation.changed` /
   `v1_accepted`). It sets the connection back to `v1` and clears the note. The web app
   asks for the connection's name before doing it and says to confirm the downgrade with
   the other server's admins.
4. **The latch re-arms by itself**: the first request with a valid `v2` signature requires
   `v2` again (and clears the note), as for any connection.
5. **Outgoing requests are unchanged**: they always carry `v1` and `v2`, so a server below
   0.99.2 verifies them; nothing has to be reset on our side for it to receive.

## Consequences

- A downgraded peer is recovered without reconnecting: its held-up deliveries are taken as
  they are retried (refused requests never reached the replay cache) and shared channels
  stay linked.
- While older signatures are allowed, the connection has the 0.99.1 protection only (a
  captured request could be sent to the other endpoint within five minutes). This is the
  admin's explicit, audited choice and ends with the peer's next `v2` request.
- Someone able to capture a valid request (behind TLS) could strip `v2` to raise the note;
  that only shows a warning, and allowing older signatures still needs an admin.

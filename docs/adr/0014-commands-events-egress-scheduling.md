# 0014. Slash commands, event subscriptions, egress and scheduled messages (v0.11)

- Status: accepted
- Date: 2026-10-22

## Context

v0.10 let systems push into Cenacle. v0.11 lets Cenacle call out to bots (slash
commands, event subscriptions), which makes the server send requests to addresses that
administrators type in: without care, a way to reach the internal network (SSRF). People
also want to send messages later and be reminded.

## Decisions

1. **One egress client** (`internal/egress`) makes every request to a bot. It resolves the
   name itself, refuses loopback, private, link-local, CGNAT, multicast and other special
   addresses (IPv4 and IPv6, including IPv4-mapped), and connects to the address it
   checked, so DNS rebinding cannot swap it. No proxy from the environment, no redirects,
   10 s per request, answers read up to 1 MiB. `https` only; `CENACLE_EGRESS_ALLOW` lists
   networks that may be reached anyway (a bot inside the company network) and
   `CENACLE_EGRESS_ALLOW_HTTP` permits `http` (development). Addresses are checked when
   they are saved and again at every connection.
2. **Signed requests.** Every request carries
   `X-Cenacle-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`. Each
   command and subscription has its own secret (`cns_…`, shown once). Receivers compare in
   constant time and reject old timestamps (5 minutes is the documented tolerance).
3. **Slash commands.** Built-ins: `/remind`, `/join`, `/leave`, `/topic`, `/me`, `/shrug`.
   A bot registers `/trigger` (unique per workspace, built-in names are reserved) with a
   request address. Running it POSTs the command, text, user and channel; the answer is
   `{"response_type": "ephemeral"|"in_channel", "text", "attachments"}`. Ephemeral answers
   are shown only to the caller (not stored); in-channel ones are posted as the bot with
   the caller's rights in that channel (announcement channels stay read-only). Failures
   answer `502 command_failed`; the caller's text is given back. `//text` sends `/text` as
   a message.
4. **Event subscriptions.** A bot subscribes an address to `message.created|updated|
deleted` and `reaction.added|removed`. Deliveries are written **in the transaction of
   the change** (next to the outbox event), only for bots that are members of the channel
   and never for the bot's own actions, so a delivery exists exactly when the change does.
   A River job sends due deliveries every 5 s (claimed with `FOR UPDATE SKIP LOCKED`, the
   attempt counted up front): success is any 2xx; otherwise retries back off from 30 s to
   1 h, and after 8 attempts the delivery is failed. Admins see the log (status, HTTP code,
   error) and can send any delivery again; records are pruned after 14 days. Delivery is
   at least once: `X-Cenacle-Delivery` identifies a delivery for de-duplication.
5. **Scheduled messages and reminders** live in `scheduled_messages`. A River job sends
   due ones every 10 s, a batch per transaction, so a crash never marks unsent rows sent;
   the nonce is derived from the row, so a retry cannot post twice. At send time the
   author must still be a member who may post there; otherwise the row is marked failed
   with a reason. `/remind` parses English and Turkish (`in 10m`, `10 dk sonra`, `at
15:30`, `yarın 9:00`) in the caller's time zone and is sent by a per-workspace
   **system bot** ("Cenacle", not listed with the workspace's bots) in a direct
   conversation with the caller.
6. **Token rotation** issues a new token with the old one's name, scopes and lifetime, and
   lets the old one work for 0–168 hours (0 revokes it at once).
7. GitLab (push, merge request, pipeline result, issue, comment) and Alertmanager
   (firing/resolved with severity colors) are added as incoming webhook kinds, like Jira.
8. Commands, subscriptions and rotations are in the workspace audit log.

## Consequences

- Bots inside the company network need `CENACLE_EGRESS_ALLOW`; the error says so.
- Slash commands wait for the bot (up to 10 s); slow work should answer at once and post
  later with a token.
- Ephemeral answers disappear on reload by design.

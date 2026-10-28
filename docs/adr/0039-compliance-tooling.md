# 0039. Audit export and SIEM, data subject requests, archive exports, spillage (v0.36)

- Status: accepted
- Date: 2026-10-24

## Context

Items K2, K6, K1 and K3 of the 2026-10-23 plan. The audit log was readable per workspace
only; there was no way to hand someone their data or erase them; eDiscovery exported NDJSON
on demand but archiving systems take other formats on a schedule; and a message that leaked
something could only be deleted like any other, which a legal hold then kept.

## Decisions

1. **The installation's audit log** is listed and downloaded by instance administrators
   with keyset paging (no OFFSET) and filters by action prefix, actor, workspace and time.
   **Streaming** is pull-based from the log itself: a job sends events after a cursor kept
   in the instance settings, so nothing is lost while the receiver is down and nothing
   depends on the request that wrote the event. HTTP batches are NDJSON signed like bot
   deliveries; syslog is RFC 5424 with octet counting over TCP, optionally TLS, through the
   egress policy's own dialer (the same SSRF rules as HTTP). Streaming starts at the moment
   it is turned on; history is downloaded instead.
2. **Data subject requests:** access is a streamed NDJSON of everything stored about a
   person, for themselves (rate limited) or by an administrator; both are audited.
   **Erasure anonymizes rather than deletes the account row**, because messages that legal
   holds keep still need an author, and other people's threads stay coherent. The account
   is unlinked from its identity (`auth_service = 'erased'`), so signing in again creates a
   new account. Messages without a hold are soft-deleted at once and purged by the existing
   purge; held ones remain until the hold is released. The audit entry records counts, not
   who the person was.
3. **Archive exports** are written by the server in CSV, Actiance XML and EML (one message
   per file, in a ZIP) on demand, and daily per workspace into the object store, catching up
   missed days. Delivery to a vendor (SFTP, SMTP journaling) is left to the operator's
   tools: these are archiving systems, not chat products, but sending to them needs vendor
   credentials Cenacle should not hold.
4. **Spillage overrides legal holds.** A report holds the message for reviewers (chosen per
   workspace, owners by default) who see its text only while it is open. Removal redacts
   the message in place (so thread structure and references stay), deletes its edits,
   reactions, mentions, saved copies (and their pending reminders, which quote the text)
   and files including their bytes, empties the snapshot in messages that forwarded it
   (`message.updated` for each), and emits `message.deleted` to devices and shared servers
   in the same transaction. The incident
   report keeps a SHA-256 and length of the text, the author, the exposure (channel members
   and shared servers) and the counts removed, never the text. Notifications already shown
   and copies outside Cenacle cannot be recalled; the report says so.

## Consequences

- Migrations `00039`–`00042`, reversible. A rollback stops streaming and daily exports and
  forgets spillage reports; erased accounts stay erased.
- The egress client gains `Dial` for raw TCP under its policy.

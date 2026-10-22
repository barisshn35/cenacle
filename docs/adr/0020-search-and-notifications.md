# 0020. Search and notifications (v0.17)

- Status: accepted
- Date: 2026-10-22

## Context

People need to find old messages and files, and to decide what reaches them, when and how:
sounds, desktop notifications, notifications on devices where Cenacle is closed, e-mail
about what they missed, muting and quiet hours. Everything must run self-hosted and keep
working air-gapped; a search engine or a notification SaaS is not an option.

## Decisions

1. **Search in PostgreSQL.** Full-text search with the `simple` configuration and
   `unaccent` (case and accents do not matter, the same for every language), wrapped in
   IMMUTABLE functions `cenacle_search_vector(text)` and `cenacle_search_query(text)` and
   indexed with **GIN expression indexes** on messages and file names, not stored columns
   (no column every `SELECT m.*` would carry). Every word of a query matches the beginning
   of a word (`:*`); `-word` leaves messages with it out. Results are only from channels the
   person is a member of, newest first, with cursor pages. Filters: workspace, channel,
   author, date range, with files, with links. A dedicated search engine stays an option for
   v0.27 load tests.
2. **Jump to a result**: the message list loads older pages until the message is there (at
   most 40 pages), then scrolls to it and highlights it for a moment; otherwise it says the
   message is too far back.
3. **Notification settings live on the server** (`notification_prefs`, JSON; per channel
   `channel_notification_prefs`: level, mute until, sound; per workspace mute). The same
   rules (`internal/notify`, ported to the web app) decide everywhere: pause, channel and
   workspace mute, quiet hours (in the person's time zone, past midnight too) and the level
   (all, mentions, nothing; direct messages notify unless muted).
4. **Sounds**: ten built-in sounds synthesised with Web Audio (no audio files to license or
   ship); people upload up to five sounds of their own (MP3, OGG, WAV, WebM, 1 MB,
   recognised by their first bytes), served only to their owner.
5. **Web push** (RFC 8030 with VAPID, `webpush-go`) is **off by default**: messages travel
   encrypted through the browser makers' push services, which an air-gapped installation
   cannot reach and some organisations do not want. The VAPID keys are generated once and
   kept in the database (every server instance shares them). A River job every ten seconds
   sends what arrived since its cursor to people with no open connection, through the
   egress client (SSRF rules); gone subscriptions are removed.
6. **E-mail** about missed mentions and direct messages (people turn it on and choose the
   delay: 5, 15 or 60 minutes) is sent by a River job every minute over SMTP (STARTTLS, TLS
   or a trusted relay), once per message, only while it is still unread and at most a week
   old; the text is in English and Turkish and shows each message as a short excerpt
   (300 characters) with a link, so organisations that do not want message text in
   e-mail leave SMTP unset.
7. **Muted channels** are dimmed in the sidebar with an icon (not color alone); mentions
   still show their badge.

## Consequences

- Search quality is word-prefix matching without stemming; it is the same in every
  language and needs no dictionaries.
- `unaccent` must be available: it is a trusted extension, so the database owner creates
  it (no superuser needed).
- Web push needs outbound HTTPS to the push services when turned on.

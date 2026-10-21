# 0011. Rich messages, reactions, mentions and the transactional outbox (v0.9)

- Status: accepted
- Date: 2026-10-21

## Context

Messages were plain text, and live events were appended to the Valkey stream after the
database change: an event could be lost if Valkey was unreachable at that moment. v0.9
brings Markdown, mentions, reactions and message cards, and makes event delivery reliable.

## Decisions

1. **Markdown is stored as written**, never HTML. The web app renders CommonMark with
   GitHub tables, strikethrough and task lists (`react-markdown`, `remark-gfm`) and
   sanitizes the result (`rehype-sanitize`); raw HTML is not rendered. Links open in a new
   tab with `noopener noreferrer nofollow ugc`. Images are shown as links: loading them
   would tell other sites who reads the chat. Headings render at text size.
2. **Code** is highlighted with shiki, loaded on first use with its JavaScript regex
   engine (no WebAssembly, nothing to add to the CSP) and only the languages that appear;
   high-contrast GitHub themes keep WCAG contrast. Unknown languages stay plain.
3. **Mentions** are `<@user-id>` in the body. The server stores the mentioned members of
   the channel (others are ignored), recomputes them on edit, and counts unread mentions
   per channel (`mention_count`, up to 100). The web app suggests channel members after
   "@", inserts "@Name" and turns the picked names into `<@id>` when sending; editing turns
   them back. Mentions of the reader are highlighted (chip, edge and tint, not color
   alone), and channels with unread mentions get a number badge (glossary rule 5).
4. **Reactions**: one emoji per reaction (checked on the server), up to 50 kinds per
   message, `reaction.added`/`removed` events, counts with "me" per reader; edits keep the
   reader's reactions. The emoji picker is Frimousse (MIT) with Emojibase data (MIT)
   served by the app itself under `/emoji/en/` (built from `emojibase-data`): no CDN.
   Emojibase has no Turkish data; search is in English.
5. **Attachments** are structured cards (title, link, Markdown text, up to 10 fields,
   footer, a stripe color from five named tones), up to 5 per message, validated by the
   server; a message with cards may have no text. Bots (v0.10) use them.
6. **Transactional outbox.** A change and its event are written in one transaction to
   `event_outbox`; `pg_notify` wakes the relay. One relay per installation, elected with a
   PostgreSQL advisory lock (named after the schema), moves events in id order to the
   Valkey stream and deletes them; another instance takes over when the leader stops.
   Delivery is at least once; clients already ignore what they have. A dedicated relay
   (not a job queue) keeps the order of events, which River jobs would not.
7. **River** (MPL-2.0, used as a library) runs background work: the periodic purge of
   deleted messages and of expired sessions now run once per interval across instances
   instead of in every instance. `server migrate up` also applies River's migrations.
   Webhooks and notifications (v0.10+) will be River jobs inserted in the same transaction
   as their cause.

## Consequences

- `Message` gains `mentions`, `reactions` and `attachments`; `Channel` gains
  `mention_count`; `NewMessage` accepts `attachments`.
- Live events reach clients a few milliseconds later (through the relay) and survive a
  Valkey outage: they wait in the outbox until it is back.

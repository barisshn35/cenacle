# 0024. Richer communication (v0.20)

- Status: accepted
- Date: 2026-10-22

## Context

People expect a chat to show what a link is about, to send a quick voice note, to pass a
message on, to react with their team's own emoji and to reach a whole channel at once.
Some conversations hold things that should not stay around. Mattermost, Slack, Discord
and Teams offer these; Cenacle does, self-hosted and without outside services.

## Decisions

1. **Link previews are fetched by the server**, never by browsers (a reader's address
   would reach the site). The first link of a message (not one in `<…>`) is stored with
   the message as pending; a periodic job (every 3 s) fetches it through its own egress
   client: public addresses only — the integrations' allow list is not used, since anyone
   can post a link — https only, redirects followed and checked again (up to 3), 10 s and
   2 MB at most. Open Graph and Twitter tags, else `<title>` and the description, are
   kept; the picture is reduced like file previews and served from `/api/pictures`.
   Previews are shared by every message linking the same address and refreshed after a
   day; failures are remembered too. `message.preview` updates clients; the author can
   remove a preview. `CENACLE_LINK_PREVIEWS=false` turns the feature off (air-gapped
   installs).
2. **Voice messages and clips are files** with `media_kind` (`voice`, `clip`), a length
   and, for voice, a waveform of up to 64 levels computed while recording. They are
   recorded with the browser's MediaRecorder and uploaded like other files (ADR 0015), so
   scanning, quotas and pruning apply; no transcoding on the server.
3. **Forwarding stores a snapshot** (author, text, channel name, time) with the new
   message, so the copy stays readable for people who cannot see the original and after
   it changes. Forwarding needs read access to the source and post access to the target;
   burn-on-read messages cannot be forwarded.
4. **Custom emoji and stickers belong to a workspace** (up to 500 emoji and 200 stickers),
   stored as pictures (PNG/GIF/JPEG/WebP, animated GIFs kept). Members add them; their
   adders and admins remove them; guests only use them. Emoji are `:name:` in text and
   reactions (the server accepts a custom reaction only if the workspace has it); text
   rendering turns known names into pictures outside code. A sticker is a message of its
   own. `emoji.changed` refreshes clients.
5. **Mentions of many are mentions.** `@channel`/`@everyone`, `@here` (members online at
   that moment), `@admins` (admins and owners) and `@owners` add a mention per person
   reached (`message_mentions.kind`), so unread counts, notifications and e-mail treat
   them as mentions without new paths; a message lists them in `broadcast`. The composer
   asks before `@channel`/`@here` in channels of more than five other members. Bots and
   scheduled messages have no presence: their `@here` reaches no one. `@all`, and the
   Turkish `@herkes` and `@kanal`, mean `@channel`; `@burada` means `@here` (1.0). None of
   them can be a group's handle, and the `@` suggestions offer them to those who may use them.
6. **Burn-on-read** is for direct and group conversations (10 s to 24 h). Recipients get
   the message without its text (also in live events, notifications and e-mail) and
   reveal it once; the reveal time is recorded per person and the text is withheld after
   that person's time. The message cannot be edited, pinned, saved or forwarded and is
   left out of search. A periodic job deletes it once every recipient's time has passed,
   or after seven days.

## Consequences

- The server makes outgoing requests on behalf of anyone who posts a link; they are
  limited to public addresses, short and small, and can be turned off.
- Burn-on-read limits what Cenacle keeps; it cannot stop a recipient from copying what
  they see, and the UI says nothing to suggest otherwise.
- Clips and voice messages use the formats browsers record (WebM/Opus, or MP4 on Safari);
  some browsers may not play another browser's recordings.

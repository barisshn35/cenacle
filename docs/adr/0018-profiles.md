# 0018. Profiles, pictures and custom status (v0.15)

- Status: accepted
- Date: 2026-10-22

## Context

People want to recognise each other at a glance (pictures, @usernames), see whether someone
is reachable (custom status, local time, last seen) and reach them from anywhere their name
appears. Workspaces want a description and an icon. Names come from Cenacle ID (ADR 0004),
pictures may come from the company directory (ADR 0017).

## Decisions

1. **The chat owns the presentation of a profile.** Pictures, @usernames, custom status,
   time zone and the last-seen setting live in the chat database; the name and the address
   stay Cenacle ID's (local accounts change their name on Cenacle ID's account page; the
   directory feed brings the change within a minute).
2. **Pictures in PostgreSQL** (`pictures`, at most 2 MB each), not in the object store:
   they are small, needed by every client and must work without files configured. An
   upload (PNG, JPEG, GIF, WebP, at most 5 MB, decompression-bomb guard) becomes a 256 px
   square PNG cut from the middle, with JPEG orientation applied and metadata dropped. An
   **animated GIF** (at most 2 MB and 1024 px) is kept as uploaded, with a still PNG of its
   first frame for people who reduce motion; frames are counted by walking the GIF's blocks,
   never by decoding them all. A new picture gets a new id, so `/api/pictures/{id}` is cached
   for good (`immutable`, private, a sandboxing CSP, `nosniff`).
3. **Directory photos** (the directory's photo attribute) reach the chat through the
   directory feed: each person carries the SHA-256 of their photo, and the chat fetches a
   changed one from `/directory/v1/photos/:sub` (same Basic authentication). It becomes the
   picture unless the person chose one.
4. **@usernames for everyone.** Directory accounts use their sign-in name and cannot change
   it; when the directory gives a name someone chose, they get another. Others get one from
   their address (or name), lower case with Turkish letters folded, suffixed when taken, and
   may change it (2–30 of `a-z0-9._-`; `all`, `here`, `channel`, `everyone` are reserved).
   Unique regardless of case.
5. **Custom status**: an emoji (no letters or digits) and/or up to 100 characters, with an
   optional end within a year. Reads treat an ended status as none at once; a job every 30
   seconds clears ended ones and announces it. The last five are remembered for reuse.
6. **Last seen** is written when presence takes someone offline; others see it only while
   they are offline and only if the person allows it (on by default).
7. **Time zone**: the app reports the browser's IANA zone once; people may set another. The
   server embeds the time zone database (distroless images have none).
8. **Who sees a profile**: oneself, bots, people of a shared workspace (guests: only people
   of a shared channel) and people of a shared channel or conversation. `GET /api/profiles`
   takes up to 100 ids; the web app gathers the reads of a moment into one request. The
   same guest rule (`policy.VisiblePeople`) filters every read that names people: member
   lists, search, presence, event creators and attendees, and mention-group members.
9. **`user.updated`** (durable) goes to the people of the user's workspaces and the user's
   own devices; clients read the profile again. In a workspace where the receiver is a
   guest, it and `presence.changed` reach them only for people they may see.

## Consequences

- The database grows by about a picture per person (a few hundred kilobytes at most for an
  animated one); backups include them.
- Name changes of directory and provider accounts happen in the directory or provider.

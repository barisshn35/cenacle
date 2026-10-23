# 0034. Reading and arranging, groups, edit history, signed releases (v0.31)

- Status: accepted
- Date: 2026-10-24

## Context

Before 1.0, Cenacle needs the everyday tools every comparable chat has (the 2026-10-23
plan, items M1, M2, M3, M7, M12 and S3): marking things unread, arranging one's own
sidebar, mentioning a team at once, seeing how a message changed, keyboard shortcuts, and
releases whose origin can be checked.

## Decisions

1. **Mark as unread** moves the read position back to just before a message (a reply:
   its thread's; a reply also sent to the channel: both). What was marked stays unread
   while it is open: reading resumes once the person leaves, sends there, or reads it on
   another device (`channel.unread` tells their other devices). Marking a channel unread
   from the sidebar marks the newest message of someone else, as one's own never count
   as unread. Marking read no longer needs a message (the newest one).
2. **The sidebar arrangement is one document per person and workspace**
   (`sidebar_layouts.layout`, jsonb), written whole (`PUT …/sidebar`): Favorites, sections
   of one's own, which channel goes where, the order and folding of sections and whether
   unread ones gather at the top. The server keeps only what still exists (channels the
   person is in, sections that exist). Many small endpoints would buy nothing: it is
   the person's own state, changed one gesture at a time, and the last write wins.
   Channels and sections move by dragging and from their menus (WCAG 2.5.7).
3. **Groups people mention** are a workspace's (`mention_groups`): `@handle` reaches the
   group's members who are in the channel, as a recorded mention of each
   (`message_mentions.kind = 'group'`), so unread mentions, notifications and e-mail treat
   it like a mention without new paths. A group can follow a directory group (members
   then come from the directory, through the `mention_group_people` view). Creators manage
   their groups; administrators choose whether members may create them. Names that
   already mention many (`@here`, `@channel`, …) cannot be handles. Clients recognise
   handles from the group list, as the body keeps `@handle` as typed.
4. **Edit history** keeps the replaced text in `message_edits`, deleted with its message
   (retention, purge after deletion), and goes into eDiscovery exports. Its author sees
   it; a workspace can show it to everyone who sees the message. Restoring is an edit.
5. **Keyboard shortcuts** follow the conventions of other chats where the browser allows
   it (Ctrl+Shift+C is the browser's, so code is Ctrl+E); Ctrl+/ lists them.
6. **Signed releases without a transparency log.** Images (with every platform image and
   build attestation), per-platform SPDX SBOMs (as signed attestations, and as files in
   the package registry) and the desktop app's `SHA256SUMS` are signed with the project's
   cosign key. A public log (Rekor) would need the Internet to sign and to verify; with
   a key alone, organisations verify releases offline with `deploy/cosign.pub`. The
   private key lives only in protected CI/CD variables (`ci/setup-signing.sh`).

## Consequences

- Three migrations (`00027`–`00029`), all reversible; group mentions recorded before a
  rollback are dropped with it.
- A renamed group keeps its old handle in messages already sent, like Mattermost.
- Until the key is set up, releases are published unsigned and their pipeline says so.

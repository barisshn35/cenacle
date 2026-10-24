# 0041. More importers, moving workspaces between servers, more file stores (v0.38)

- Status: accepted
- Date: 2026-10-25

## Context

Items O2, O3 and O4 of the 2026-10-23 plan. Cenacle imported Mattermost and Slack exports
(ADR 0016). Teams moving from Rocket.Chat, Zulip, Discord or Microsoft Teams had no way in,
a workspace could not move to another Cenacle server, and files needed an S3 service.

## Decisions

1. **Importers read files, never the other product** (no bridges, no credentials of the
   other service). Each reader turns an export into the importer's one data model; the
   writer (people by e-mail, channels by name, messages by a nonce, history read) stays
   shared, so every source is idempotent the same way.
   - Rocket.Chat has no server export: `mongoexport` of four collections (JSON lines or
     arrays, MongoDB extended JSON dates).
   - Zulip: its organization export (`realm.json`, `messages-*.json`); topics are kept as a
     bold first line when a topic starts.
   - Discord has no server export: the JSON of DiscordChatExporter (MIT, run by the
     administrator). Discord gives no addresses, so those people cannot sign in.
   - Teams has no export file: Microsoft Graph's chatMessage JSON in a documented layout;
     its HTML becomes Markdown.
   - Archives are opened in place (zip) or unpacked into a temporary directory (tar.gz),
     never outside it.
2. **Workspaces move with a Cenacle export** (`server export`, `server import cenacle`): a
   zip with a versioned JSON-lines manifest and the files. It carries what makes up the
   conversation (people with roles, channels with members, messages with threads,
   reactions, pins, forum titles and tags, files); settings and app content (bots, polls,
   canvases, lists, workflows) are not part of it. People are matched by their Cenacle ID
   identity first, so a move between servers of the same Cenacle ID keeps everyone's
   account. Mentions are rewritten to the new ids. Encrypted channels are left out (their
   text is ciphertext without the passphrase). A whole server moves with a backup, as
   before.
3. **The file store is an interface** with three backends: S3 (as before), Azure Blob
   Storage and a directory. Azure is spoken to with a small client of its REST API and a
   shared key (pinned API version); the official SDK would add about 10 MB and Apache Arrow
   to the server for four calls. For Azure and directories browsers upload **to the chat
   server** with the same form as for S3: a one-time ticket in Valkey (GETDEL) fixes key and
   size, the server checks the exact size and writes the object, with a longer deadline
   for that request only. Uploaded files then go through the same check (scan, sniffing,
   previews) as with S3.

## Consequences

- No migration and no new dependency.
- CI runs the storage tests against Azurite (MIT, Microsoft's emulator); its published
  development key is allowed in the secret scan.
- `CENACLE_FILES_BACKEND` chooses the store; without it an S3 endpoint means S3, so
  existing installs are unchanged.

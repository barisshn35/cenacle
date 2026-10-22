# 0028. Compliance and access control (v0.23)

- Status: accepted
- Date: 2026-10-22

## Context

Regulated organizations must decide how long conversations are kept, keep them anyway when
a dispute or investigation needs them, hand them over on request, mark how sensitive a
channel is, limit channels to the right people, and sometimes keep content even from the
server's operators. Enterprise chat products sell these as compliance add-ons; Cenacle ships
them open source.

## Decisions

1. **Retention** is a number of days per workspace (none: forever), overridden per channel
   by workspace owners and admins. A periodic job deletes expired messages for good, in
   batches of 5,000 a minute.
2. **Legal holds** (workspace owners) name people and/or channels and an optional period.
   A held message escapes every deletion: retention, the purge of deleted messages after
   their restore window, and burn-on-read (held burned messages are deleted for people but
   kept). Holds are evaluated by one SQL function, `message_held`, used by every purge.
   Releasing a hold lets retention apply again. Holds are audited.
3. **eDiscovery** (workspace owners): an export streams messages as JSON lines (people,
   channels, period, words), deleted and held ones included, page by page with a cursor.
   Every export is audited with its filter. Encrypted channels export their envelopes.
4. **Classification banners**: up to 10 per workspace (name, text, color), a default for
   channels, and a channel's own. The banner shows the name as text, never color alone.
5. **Attribute-based access**: a workspace defines member attributes (up to 20, e.g.
   department); owners and admins set members' values. A channel's access rules require
   one of the listed values of every rule (case-insensitive). Rules are checked when people
   join or are added; when rules or a member's values change, members who no longer meet
   them leave the channel at once (audited). Channels for everyone take no rules.
6. **End-to-end encrypted channels** (optional, chosen at creation): members share a
   passphrase outside Cenacle. The browser derives an AES-256-GCM key with PBKDF2-SHA-256
   (600,000 rounds, a random salt) and keeps it on the device as a non-extractable
   `CryptoKey` in IndexedDB. The server stores the salt with a "key check" (a known text
   sealed with the key) so members find out at once when a passphrase is wrong, and accepts
   only envelopes (`e2e:v1:<iv>:<ciphertext>`) in such channels, and no envelopes elsewhere.
   It cannot read them, so bots, commands, workflows' posts, forwarding, files, link
   previews, search, AutoMod and notification texts are not available in them.

## Consequences

- Retention deletes for good; restoring needs a backup. Holds are the way to keep data.
- A forgotten passphrase cannot be recovered; changing it needs a new channel.
  Per-device keys with key exchange (MLS) can replace the shared passphrase later without
  changing the envelope format's version prefix rules.
- Directory-group sync adds members without checking access rules; use one or the other
  for a channel.

# Compliance operations

Audit log export and SIEM streaming, data subject requests, archive exports and data
spillage. Retention, legal holds, eDiscovery and classifications are in the workspace's
Compliance page (ADR 0028).

## Audit log and SIEM

**System console → Audit log** lists every event the chat server records: instance
settings, administration, workspaces, channels, bots, moderation, compliance, federation,
guest links and the end of sessions (a device signed out, all devices, or ended by Cenacle
ID or an administrator). It filters them by kind or action and downloads them as NDJSON
(`GET /api/admin/audit/export`, the same filters as `GET /api/admin/audit`).

Sign-ins are not in this log: the chat signs people in through Cenacle ID and only keeps
the time of the last sign-in (in the person's data export) and the new device with its
address (the signed-in devices in Settings). Sign-ins, failed attempts, two-step
verification and passkey changes, and the actions of Cenacle ID administrators and SCIM
clients are in **Cenacle ID's own audit log**, in Cenacle ID's database (table
`audit_events`). People see their latest ten events on their Cenacle ID account page;
there is no administrator view or export of it, and it is not part of the stream below.

Streaming sends new events within seconds, oldest first; when the receiver is down they
wait at a cursor and go when it is back. It starts with the events written after it was
turned on.

- **HTTPS endpoint:** each batch is a `POST` of NDJSON (`application/x-ndjson`). With a
  signing secret, `X-Cenacle-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>">`
  (as for bots, ADR 0014). Answer 2xx to accept the batch.
- **Syslog:** RFC 5424 messages over TCP with octet-counting framing (RFC 6587), over TLS
  when ticked (RFC 5425, port 6514 usually). Facility security/authorization (10),
  severity notice; `APP-NAME` is `cenacle`, `MSGID` the action, the message the event as
  JSON.

Each event has `id`, `at`, `action`, `actor_id`, `actor_name`, `workspace_id`,
`workspace_name`, `target_type`, `target_id`, `ip_address`, `detail` and `server` (the
chat's host). Receivers inside your network need `CENACLE_EGRESS_ALLOW` (and
`CENACLE_EGRESS_ALLOW_HTTP` for plain http).

## Data subject requests (GDPR, KVKK)

- **Access:** people download their data in Settings → Account → Your data (three times
  in ten minutes at most); administrators do it for anyone in System console → People (the
  download button). NDJSON, one item per line:
  - `profile`: id, name, address, username, time zone, status, when the account was
    created, last signed in, last seen and deactivated, administrator, guest;
  - `ai_consent`: the answer to the AI notice, its model and time;
  - `workspace` and `channel`: memberships with the role;
  - `message`: every message they wrote, deleted ones included (text, channel, thread,
    times, whether it has files), and `message_version`: the earlier versions of edited
    ones;
  - `reaction`, `file` (name, type, size, channel and message) and `file_content` (the
    file's bytes in base64, a mebibyte per line), `session` (signed-in devices with
    browser, address and times) and `audit` (the audit events they did);
  - since 1.0 also: `profile_picture`, `font` and `sound` (with their bytes), saved items,
    scheduled messages, reminders, acknowledgements, mentions, followed threads, poll votes,
    form answers, event replies, reports, AI usage records, notification, appearance and
    sidebar settings, push subscriptions (without their keys), encryption devices and
    backups (without key material), what they made (events, forms, list items, canvases,
    tabs, feeds, emoji, stickers, mention groups, playbooks, workflows, bots, tokens,
    commands, webhooks, subscriptions, guest links; without their secrets) and
    `audit_about`: the audit events others did about them (without who and from where).

  Not in it: member attributes, and anything kept by Cenacle ID (account, sign-in methods,
  its audit log). That comes from Cenacle ID
  itself: people download it on their account page (**Your data → Download my data**),
  administrators in its admin panel (**Accounts → Export data**) or with
  `cenacle-idp users export --email <address>` (see
  [identity](../install/identity.md#accounts) for what is in it).

- **Erasure:** System console → People → Erase (type the name to confirm). In one step the
  account loses its name, address, username, status, time zone and profile picture (the
  picture itself goes too), becomes "Deleted user" and can no longer sign in. All its
  messages are deleted and purged for good within the restore window, except those a legal
  hold keeps; open apps, the bots subscribed to `message.deleted` in those channels and the
  servers the channels are shared with are told, all at once (a Cenacle server deletes
  them unless its connection is set not to take edits). Reactions, saved items,
  scheduled messages, signed-in devices and push subscriptions, directory groups, followed
  threads, the answer to the AI notice, uploaded fonts and sounds and the copies of their
  messages still queued for bots and shared servers go; daily archive files are written
  again without them. The audit log keeps that it happened and the counts, not who it was.

  Messages a legal hold keeps are deleted for people too (nobody sees them any more) but
  keep their text and earlier versions for eDiscovery; once no hold keeps them, the next
  clean-up purges them.

  Not removed: memberships of workspaces and channels with member attributes, preferences,
  poll votes, form answers, event replies, acknowledgements, encryption devices, AI usage
  records, reports they made, the audit events they did, and their name where others
  mentioned or quoted them.

  The Cenacle ID account is deleted there: admin panel (`/account/admin`) → Accounts →
  Delete, or `cenacle-idp users delete --email <address>`. That removes the address, name,
  password hash, two-step verification, passkeys, groups and photo, ends every session
  (the chat deactivates the person within a minute) and blanks the IP addresses and
  personal details of the audit events they did; the events stay, without the account.
  While a directory or identity provider still has the person, their next synchronization
  or sign-in creates a new account; remove them there first. To only keep the person from
  signing in, disable the account instead (Accounts → Disable,
  `cenacle-idp users disable --email <address>`, a SCIM `DELETE`, or removing them from the
  directory): their sessions end and their Cenacle ID data stays.

## Legal holds

A legal hold (Compliance page, owners) keeps the messages of some people and/or channels,
written in a period, while it is active. What it stops:

| Deletion                                                                      | With a hold                                                                      |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Deleting a message (its author, a channel manager, a report, a shared server) | the message disappears for people but is not purged; eDiscovery still exports it |
| Editing a message                                                             | allowed; every earlier version is kept and exported with it                      |
| Retention                                                                     | skips held messages, and thread roots with a held reply                          |
| Burn-on-read                                                                  | the message disappears for people but is not purged                              |
| Erasing a person                                                              | their held messages disappear for people but are not purged (see above)          |
| Files                                                                         | stay with their message; only uploads never sent can be deleted                  |
| Workspaces, channels                                                          | cannot be deleted (channels are archived)                                        |
| **Removing spillage**                                                         | **not stopped:** the text, history, files and other traces go (see below)        |

A hold keeps the message, not copies on their way out: erasure takes a person's held
messages out of the queues for bots and shared servers. A released hold keeps nothing from
then on, and a release cannot be undone: messages kept only by it are purged by the next
clean-up (deleted ones within minutes, expired ones by retention); those of an erased
person are deleted ones.

## Archive exports

Compliance page → **Archive export** (owners): a period now, or every day.

| Format       | For                                           | Content                                                                                                  |
| ------------ | --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| CSV          | spreadsheets, scripts                         | one row per message: ids, time, channel, author and address, thread, text, edited, deleted, file names   |
| Actiance XML | Vantage, Smarsh and others that take Actiance | one `Conversation` per channel with `ParticipantEntered`, `Message` and `FileTransferStarted`            |
| EML in a ZIP | Global Relay, Proofpoint, mail archives       | one RFC 5322 message per chat message, `Message-ID` and `In-Reply-To` for threads, `X-Cenacle-*` headers |

Daily exports need the object store: after each UTC day ends (checked every ten minutes)
its file is written under `archive/<workspace>/<day>.<ext>` and listed for download. A
server that was down catches up a week at a time. Deliver files to a vendor with your own
transfer (SFTP, the vendor's agent); Cenacle does not send them.

A day's file follows removals made after it was written: when messages of that day are
removed as spillage, purged (deleted, retention, burn-on-read) or their author is erased,
the file is written again from what is left (and removed when nothing is). Until then
(at most ten minutes) it is not served.

## Data spillage

Anyone can **Report spillage** on a message (message actions). The workspace's spillage
reviewers (chosen by the owners in the Spillage reports dialog; the owners when none are
chosen) see the message and decide:

- **Remove everywhere:** the text, edit history, files (their bytes too), reactions,
  mentions, saved copies with their reminders (also those already sent), the copy shown in
  forwarded messages, the text in workflow runs it started (and what they posted with it),
  the daily archive files holding it, the pin and the copies still queued for bots and
  shared servers go, **also where a legal hold would keep them** (only the emptied message,
  marked `[removed: spillage]`, stays while the hold lasts); devices drop it at once
  and shared servers are told to delete it. A removal cannot be restored. Notifications
  already shown on devices and copies outside Cenacle (e-mails, exports already downloaded)
  cannot be taken back.
- **Dismiss:** the message stays.

Either way an **incident report** (JSON) records the report, the decision, the author,
when it was written, its SHA-256 and length, who was in the channel and which servers it
was shared with, and what was removed — never the content.

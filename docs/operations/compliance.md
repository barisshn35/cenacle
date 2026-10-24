# Compliance operations

Audit log export and SIEM streaming, data subject requests, archive exports and data
spillage. Retention, legal holds, eDiscovery and classifications are in the workspace's
Compliance page (ADR 0028).

## Audit log and SIEM

**System console → Audit log** lists every event of the installation (instance settings,
administration, workspaces, channels, federation, guest links, sign-ins at the chat),
filtered by kind or action, and downloads them as NDJSON (`GET /api/admin/audit/export`,
the same filters as `GET /api/admin/audit`).

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

- **Access:** people download everything Cenacle keeps about them in Settings → Account →
  Your data; administrators do it for anyone in System console → People (the download
  button). NDJSON, one item per line: profile, workspace, channel, message, reaction,
  file, session, audit.
- **Erasure:** System console → People → Erase (type the name to confirm). The account
  loses its name, address, picture and status and can no longer sign in; its messages are
  deleted (purged for good within the restore window) except those a legal hold keeps,
  which go when the hold is released; reactions, saved items, scheduled messages, devices
  and sessions go. The audit log keeps that it happened, not who it was. Also delete the
  person in Cenacle ID (or the directory), or a new sign-in makes a new account.

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

## Data spillage

Anyone can **Report spillage** on a message (message actions). The workspace's spillage
reviewers (chosen by the owners in the Spillage reports dialog; the owners when none are
chosen) see the message and decide:

- **Remove everywhere:** the text, edit history, files (their bytes too), reactions,
  mentions, saved copies and pin go, **also where a legal hold would keep them**; devices
  drop it at once and shared servers are told to delete it. Notifications already shown on
  devices and copies outside Cenacle (e-mails, exports already taken) cannot be taken back.
- **Dismiss:** the message stays.

Either way an **incident report** (JSON) records the report, the decision, the author,
when it was written, its SHA-256 and length, who was in the channel and which servers it
was shared with, and what was removed — never the content.

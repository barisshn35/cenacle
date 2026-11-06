# Privacy

Cenacle runs on servers its operator chooses. This page lists what Cenacle stores, why, for
how long, and what leaves the server, so that operators can write their own privacy policy
and people can see what happens to their data. It describes the software; how a particular
server is run is up to its operator.

## Who is responsible

- **The operator** (the organization that runs a Cenacle server) decides why and how people's
  data is processed, and is its controller under laws such as the GDPR or KVKK. Their privacy
  policy is linked when they set it: from Settings → Account and the desktop app's pairing
  page (`CENACLE_PRIVACY_URL`), and from the foot of Cenacle ID's sign-in and account pages
  (`IDP_PRIVACY_URL`, the same address unless set apart). Without an address there is no link.
- **The Cenacle project** receives nothing from any server or app: there is no telemetry, no
  usage statistics, no crash reporting to the project and no check for updates against the
  project. The desktop app updates only from the server it is paired with and connects to
  nothing else: it checks spelling with dictionaries that come with it. (Up to 0.99.4 it
  downloaded them from Google, `redirector.gvt1.com`, the first time each language was
  checked; the request carried no content or account data, but Google saw the device's IP
  address.)

## What is stored, and why

### Cenacle ID (sign-in)

| Data                                                          | Why                                                  | Kept                                                                                                    |
| ------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| E-mail address, name, language                                | to identify the person and write to them             | as long as the account exists (an administrator can delete it)                                          |
| Password hash (Argon2id), never the password                  | to check the password at sign-in                     | until changed                                                                                           |
| Two-step verification secret (encrypted) and recovery codes   | to check the second step                             | until turned off                                                                                        |
| Passkeys (public keys only)                                   | passkey sign-in                                      | until removed                                                                                           |
| Directory groups and photo (from LDAP / Active Directory)     | roles, groups and profile pictures                   | refreshed at each directory sync                                                                        |
| Sign-in events with the address (IP) they came from           | security: who signed in, failed attempts             | in Cenacle ID's audit log, until the operator deletes it                                                |
| Sessions and app grants; failed sign-in attempts (time, kind) | keeping people signed in; limiting password guessing | sessions and grants until they end or expire; a failed attempt until the limit's time window has passed |

### Chat

| Data                                                                                                | Why                                               | Kept                                                             |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------- |
| Profile: name, username, picture, time zone, status                                                 | so others know who they talk to                   | until changed or the person is erased (the picture goes with it) |
| Messages, earlier versions of edited ones, files                                                    | the conversation itself                           | until deleted, or by the workspace's retention policy            |
| Reactions, mentions, saved messages, reminders, scheduled posts                                     | features the person uses                          | until removed                                                    |
| What was read (per channel), threads followed, receipts                                             | unread counts; read receipts only if turned on    | while the person is a member                                     |
| Presence and "last seen" (the person can hide last seen)                                            | showing who is around                             | presence for minutes; last seen until the next visit             |
| Signed-in devices: the browser's or app's user agent (up to 512 characters), address (IP), last use | listing devices and signing them out              | until signed out or the session expires                          |
| Notification settings, push subscriptions                                                           | sending notifications where the person wants them | until changed or removed                                         |
| Audit log: who changed what, with the address (IP)                                                  | security and accountability for administrators    | `CENACLE_AUDIT_RETENTION` (default: kept)                        |
| AI requests: kind and size only, never their text                                                   | limits and accountability (only with AI)          | `CENACLE_AI_REQUEST_RETENTION` (default: kept)                   |
| The answer to the AI notice, with its time and model                                                | no AI request without consent                     | until changed or the person is erased                            |
| Link previews: title, description and picture of public pages                                       | previews in messages                              | `CENACLE_LINK_PREVIEW_RETENTION` (default: kept)                 |

Drafts of messages stay on the person's device (the browser's or app's storage), not on the
server.

Encrypted channels (MLS) are stored as ciphertext: the server cannot read them. The keys stay
on people's devices; a recovery copy is kept only if the person or operator set one up.

## What leaves the server

Only what the operator sets up, and what channel managers and administrators connect
(feeds, bots, webhooks). Nothing below is needed for Cenacle to work:

- **E-mail** (`CENACLE_SMTP_*`): notification e-mails to the people who turned them on, through
  the operator's mail server. The notification policy can leave the message text out.
- **Web push** (`CENACLE_WEB_PUSH`): notifications go through the browser makers' push services
  (for example Google, Mozilla, Apple). Their content is encrypted for the device; the push
  service sees only that a notification was sent and its size. The notification policy can
  leave the text, or the sender too, out.
- **AI** (`CENACLE_AI_URL`): requests go to the model server the operator runs, only after the
  person accepted the AI notice (see [AI](operations/ai.md)).
- **Link previews** (`CENACLE_LINK_PREVIEWS`): the server, not the person's browser, fetches
  public pages linked in messages and the picture they name (`og:image`), and keeps a copy;
  those sites see the server's address.
- **Channel feeds** (`/feed`): the server reads the RSS or Atom feeds channel managers
  subscribe to; those sites see the server's address.
- **Bots, webhooks, workflows and federation**: messages go where administrators connect them.
- **Audit log stream** (System console → Audit log): audit events, with the names and
  addresses (IP) of the people who acted, go to the operator's SIEM over HTTPS or syslog.
- **Object store** (`CENACLE_FILES_BACKEND`): files go to the S3 service or Azure Blob
  Storage the operator chooses, which may be outside the server.
- **Database backups** (WAL-G, optional): copies of the chat and Cenacle ID databases, with
  everything above, go to the S3 bucket the operator names.
- **Traces** (`OTEL_EXPORTER_OTLP_ENDPOINT`): request paths (tokens in addresses replaced)
  and database queries without their values go to the operator's OpenTelemetry collector.
- **Directory and identity providers**: sign-in checks with the operator's LDAP / Active
  Directory or OpenID Connect / SAML providers.

The apps load no fonts, scripts or images from other sites.

Cenacle ID's request log (standard output, at `IDP_LOG_LEVEL=info`) records each request's
address (IP) and path; the chat server's access log records no address. These logs are kept
as long as the host's log rotation keeps them.

## People's rights

- **See and take their data:** Settings → Account → Download your data gives, as one file,
  their profile and its picture, workspaces and channels, the messages they wrote with
  earlier versions, reactions, their files with the bytes, signed-in devices, the AI
  answer, saved items, scheduled messages, votes, form answers, settings, uploaded fonts
  and sounds, what they made, the audit events they did and those about them (secrets
  such as keys and token hashes stay out). Not in it: anything kept by Cenacle ID: that
  is on the Cenacle ID account page (Your
  data → Download my data: account, photos, groups, passkeys without keys, how many recovery
  codes are left, sign-in attempts, sessions and app grants without tokens, and the audit
  events the person did; see [compliance](operations/compliance.md#data-subject-requests-gdpr-kvkk)).
- **Correct it:** the profile in Settings, and the name and e-mail in Cenacle ID.
- **Withdraw consent:** Settings → AI turns AI off for the person at any time.
- **Erasure:** an administrator can erase a person (System console → People): their name,
  e-mail, status, picture, devices, reactions, saved items, scheduled messages, uploaded
  fonts and sounds and AI answer are removed, and their messages are deleted; those under
  a legal hold are hidden too and kept for the hold, then purged. Memberships,
  preferences, votes and the audit log are kept; in the audit events they did, the address
  (IP) is blanked and only details that say nothing about them stay (what was done, to which
  channel, when). In Cenacle ID an administrator deletes the
  account (address, name, sign-in methods, groups, photo; the IP addresses of its audit
  events are blanked). While a directory or identity provider still has the person, they
  get a new account at their next synchronization or sign-in, so remove them there first.

## For operators

**Calls (optional, off by default).** Call media passes through the organization's
SFU, which can read it; calls are unavailable in encrypted/MLS channels. No media,
recording, transcript or screen content is stored. Metadata records call/channel
IDs, initiator, participant identity, session binding while active, state and times.
Active session bindings are cleared on leaving. Admission credentials last 60 seconds
and are single-use; optional TURN credentials last ten minutes. Tokens, SDP, ICE and
device labels are not logged or exported. Call-state events contain invalidations,
not participant identity lists; clients fetch current authorized/redacted snapshots.
Call outcomes in channel history contain only aggregate duration/count and outcome.

Personal exports include the requester's own call participation and public call
metadata, never another participant's session or signaling. Erasure disconnects
active participation and removes unheld participant/initiator links. A legal hold
covering the channel or a participant and overlapping the call preserves the raw
metadata in the database; the erased person's held participation is hidden from
ordinary snapshots and personal exports. After hold release the periodic purge
removes redacted links, even with calls switched off. Ended-call retention inherits
channel/workspace retention from the end time. Holds also preserve structured call
summary messages. Backups remain subject to the operator's backup retention and
access controls. See [call installation](install/calls.md).

When writing your privacy policy, say: who you are and how to contact you; which of the
optional features above you turned on and where they send data; how long you keep messages
(retention policies), the audit log and backups; who can read exports (eDiscovery); and how
people ask for their data or its erasure. Then set `CENACLE_PRIVACY_URL` (and, for another
page on Cenacle ID, `IDP_PRIVACY_URL`) to the page.

**How long records stay.** The chat server keeps its audit log, the records of AI requests
and link previews until you set a retention: `CENACLE_AUDIT_RETENTION`,
`CENACLE_AI_REQUEST_RETENTION` and `CENACLE_LINK_PREVIEW_RETENTION` take durations such as
`8760h` (a year) or `none` (the default: kept). An hourly job deletes what is older, in
batches. Audit events a running audit stream has not sent yet stay until it sends them, so
keep the audit log longer than your SIEM may be away. A deleted link preview takes its
picture with it; its messages show the bare link. Cenacle ID's own audit log is not covered
by these settings. Legal holds keep messages, not these records.

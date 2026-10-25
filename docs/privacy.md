# Privacy

Cenacle runs on servers its operator chooses. This page lists what Cenacle stores, why, for
how long, and what leaves the server, so that operators can write their own privacy policy
and people can see what happens to their data. It describes the software; how a particular
server is run is up to its operator.

## Who is responsible

- **The operator** (the organization that runs a Cenacle server) decides why and how people's
  data is processed, and is its controller under laws such as the GDPR or KVKK. Their privacy
  policy is linked from Settings → Account when they set `CENACLE_PRIVACY_URL`.
- **The Cenacle project** receives nothing from any server or app: there is no telemetry, no
  usage statistics, no crash reporting to the project and no check for updates against the
  project. The desktop app updates only from the server it is paired with.

## What is stored, and why

### Cenacle ID (sign-in)

| Data                                                        | Why                                      | Kept                                 |
| ----------------------------------------------------------- | ---------------------------------------- | ------------------------------------ |
| E-mail address, name, language                              | to identify the person and write to them | until the account is deleted         |
| Password hash (Argon2id), never the password                | to check the password at sign-in         | until changed or the account is gone |
| Two-step verification secret (encrypted) and recovery codes | to check the second step                 | until turned off                     |
| Passkeys (public keys only)                                 | passkey sign-in                          | until removed                        |
| Directory groups and photo (from LDAP / Active Directory)   | roles, groups and profile pictures       | refreshed at each directory sync     |
| Sign-in events with the address (IP) they came from         | security: who signed in, failed attempts | in the audit log (see below)         |

### Chat

| Data                                                            | Why                                               | Kept                                                  |
| --------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------- |
| Profile: name, username, picture, time zone, status             | so others know who they talk to                   | until changed or the person is erased                 |
| Messages, edits (if the workspace keeps edit history), files    | the conversation itself                           | until deleted, or by the workspace's retention policy |
| Reactions, mentions, saved messages, reminders, scheduled posts | features the person uses                          | until removed                                         |
| What was read (per channel), threads followed, receipts         | unread counts; read receipts only if turned on    | while the person is a member                          |
| Presence and "last seen" (the person can hide last seen)        | showing who is around                             | presence for minutes; last seen until the next visit  |
| Signed-in devices: browser or app name, address (IP), last use  | listing devices and signing them out              | until signed out                                      |
| Notification settings, push subscriptions                       | sending notifications where the person wants them | until changed or removed                              |
| Audit log: who changed what, with the address (IP)              | security and accountability for administrators    | until the operator deletes it                         |
| AI requests: kind and size only, never their text               | limits and accountability (only with AI)          | until the operator deletes it                         |
| The answer to the AI notice, with its time and model            | no AI request without consent                     | until changed or the person is erased                 |
| Link previews: title, description and picture of public pages   | previews in messages                              | cached by the server                                  |

Drafts of messages stay on the person's device (the browser's or app's storage), not on the
server.

Encrypted channels (MLS) are stored as ciphertext: the server cannot read them. The keys stay
on people's devices; a recovery copy is kept only if the person or operator set one up.

## What leaves the server

Only what the operator turns on. Each of these is off or optional:

- **E-mail** (`CENACLE_SMTP_*`): notification e-mails to the people who turned them on, through
  the operator's mail server. The notification policy can leave the message text out.
- **Web push** (`CENACLE_WEB_PUSH`): notifications go through the browser makers' push services
  (for example Google, Mozilla, Apple). Their content is encrypted for the device; the push
  service sees only that a notification was sent and its size. The notification policy can
  leave the text, or the sender too, out.
- **AI** (`CENACLE_AI_URL`): requests go to the model server the operator runs, only after the
  person accepted the AI notice (see [AI](operations/ai.md)).
- **Link previews** (`CENACLE_LINK_PREVIEWS`): the server, not the person's browser, fetches
  public pages linked in messages; those sites see the server's address.
- **Bots, webhooks, workflows and federation**: messages go where administrators connect them.
- **Directory and identity providers**: sign-in checks with the operator's LDAP / Active
  Directory or OpenID Connect / SAML providers.

The apps load no fonts, scripts or images from other sites.

## People's rights

- **See and take their data:** Settings → Account → Download your data gives everything stored
  about the person (profile, messages, reactions, files, devices, the AI answer, what they did)
  as one file.
- **Correct it:** the profile in Settings, and the name and e-mail in Cenacle ID.
- **Withdraw consent:** Settings → AI turns AI off for the person at any time.
- **Erasure:** an administrator can erase a person (System console → People): their name,
  e-mail, picture, devices, reactions, saved items, scheduled messages and AI answer are
  removed and their messages are deleted, except those under a legal hold. Delete them in
  Cenacle ID too, so that they cannot sign in again with a new account.

## For operators

When writing your privacy policy, say: who you are and how to contact you; which of the
optional features above you turned on and where they send data; how long you keep messages
(retention policies), the audit log and backups; who can read exports (eDiscovery); and how
people ask for their data or its erasure. Then set `CENACLE_PRIVACY_URL` to the page.

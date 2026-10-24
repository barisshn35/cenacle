# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Upgrade instructions live in [docs/upgrade](docs/upgrade/README.md).

## [Unreleased]

## [0.32.0] - 2026-10-24

Message priority and acknowledgements, read receipts, galleries and formatting
(ADR 0035).

### Added

- **Message priority:** mark a message important or urgent and ask readers to
  acknowledge it; everyone sees who did (`message.ack`,
  `PUT`/`DELETE …/messages/{id}/ack`). An urgent message can remind the people it mentions
  until they acknowledge it (`message.reminder`); owners and admins choose how often and
  how many times, or turn reminders off.
- **Read receipts** in direct and group conversations, off until owners or admins turn
  them on: your newest message shows "Seen" (or who has seen it). Everyone can keep theirs
  to themselves in their profile (`GET /api/channels/{id}/reads`, `conversation.read`).
- **Galleries:** several images in a message show as a grid.
- **Formatting bar** in the message box (bold, italic, strikethrough, code, link, quote,
  lists, code block) with a preview of the message.

### Changed

- The message box's tools stay together, with Send at their end, when they wrap.

## [0.31.0] - 2026-10-24

Reading and arranging, groups, edit history, keyboard shortcuts, signed releases
(ADR 0034).

### Added

- **Mark as unread** from a message's menu, with Alt+click, or for a whole channel from
  the sidebar; it stays unread while open (`POST /api/channels/{id}/unread`,
  `channel.unread`). Replies mark their thread unread.
- **Your own sidebar:** Favorites, sections of your own, moving channels and conversations
  between sections (drag, or "Move to" in their menu), reordering and folding sections,
  and unread ones gathered at the top; kept per workspace on the server
  (`GET`/`PUT /api/workspaces/{id}/sidebar`, `sidebar.changed`).
- **Groups:** mention a team as `@handle`. Groups have managers, can be archived and
  restored, and can follow a directory group; administrators choose who creates them. The
  composer suggests groups after "@", and group mentions count as mentions
  (`/api/workspaces/{id}/mention-groups`, `/api/mention-groups/{id}`, `groups.changed`).
- **Edit history:** "(edited)" opens a message's earlier versions; authors can put one
  back. Owners and admins can show it to everyone (`edit_history` of a workspace); it is
  part of eDiscovery exports (`GET …/messages/{id}/edits`).
- **Keyboard shortcuts:** Ctrl+/ lists them; Alt+↑/↓ (unread channels with Shift),
  Ctrl+. (details panel), Ctrl+Shift+\ (react to the newest message), ↑ and Shift+↑ in an
  empty message box (edit your last message, reply in a thread), Ctrl+B/I/E and
  Ctrl+Shift+X to format.
- **Signed releases:** images, per-platform SPDX SBOMs and the desktop app's `SHA256SUMS`
  are signed with the project's key (cosign, verifiable offline with
  `deploy/cosign.pub`); SBOMs are published as `cenacle-sbom/<version>/`.

### Changed

- `POST /api/channels/{id}/read` takes no message to mark everything read.

## [0.30.0] - 2026-10-24

The desktop app (ADR 0033).

### Added

- **Desktop app for Windows and Linux** (Electron; Windows x64 and arm64 in one installer,
  Linux AppImage, deb and rpm for x64 and arm64). It pairs with your server by its address
  and opens it; everything happens inside the app: signing in at Cenacle ID's page in a
  window of the app, Cenacle ID's account pages, links to other sites in isolated windows,
  files through the save dialog. Its own title bar with the window buttons in the app's
  colors, no menu bar; tray, taskbar count of mentions and direct messages, `cenacle://`
  links, an offline page, English and Turkish.
- Desktop sign-in on the server: `GET /api/auth/login?desktop=<challenge>` and
  `POST /api/auth/desktop/token` (a one-time code exchanged with a PKCE verifier); works
  while the web app is off. `CENACLE_DESKTOP_MIN_VERSION` makes older apps update first.
- Updates of the desktop app from your own server: `downloads/desktop/` (compose) or
  `web.downloadsClaim` (Helm), served at `/downloads/desktop/`; the "Use the Cenacle app"
  page lists the installers there.
- Playbooks list the runs in progress in your channels (`GET /api/workspaces/{id}/runs`).
- The channel directory shows how many people are in each channel (`member_count`).

### Changed

- Compliance and federation are laid out in two columns on wide screens.
- The devices list names the desktop app.

### Fixed

- An open channel now stays at its newest message while messages you send from another
  device (or a bot sends as you) keep arriving.

## [0.29.0] - 2026-10-23

The interface rewrite and a stricter sign-in (ADR 0031, ADR 0032).

### Added

- The record: conversations read like minutes, with who and when in a speaker margin; a
  channel's governance stands in a title block; the Inbox is a departures board of what
  needs you.
- Boards for Saved (grouped by reminder), Tasks, Events (answer in one click), Playbooks and
  Workflows; followed threads as cards with Stop following and Mark all as read.
- Settings and workspace settings with side navigation; Language and region with a 12- or
  24-hour clock; the channels whose notifications differ, each with a reset.
- The channel directory searches names and topics and filters by membership.
- The composer says how many people @channel, @here or @everyone reaches while you type;
  channel files filter by kind.
- Sign-in names the server and the steps that follow. Cenacle ID shows a record of the
  sign-in beside its pages and requires two-step verification by default, with the setup
  inside the sign-in (QR code, code, recovery codes).
- Server administrators can turn the web app off (desktop and mobile apps keep working);
  `CENACLE_WEB_APP=on|off` overrides the setting. `GET /api/meta` tells the app.
- Cenacle ID administration: a sign-in policy (two-step verification required, passkeys
  allowed), side navigation.

### Changed

- New look: Paper and Bone neutrals, a Forest sidebar, Brass for selection, focus and the
  main action, red only for your mentions, errors and destructive actions; Geist and Geist
  Mono everywhere, Modern as the default font template; public channels carry a speech
  bubble instead of "#".
- Sessions last until sign-out by default (`CENACLE_SESSION_IDLE_TIMEOUT` and
  `CENACLE_SESSION_MAX_AGE` default to `none`).
- Passkeys are off until an administrator allows them.
- Theme, density and language moved from the channel header to Settings.

## [0.28.0] - 2026-10-23

Release candidate preparation.

### Added

- Compose: the SMTP password and the AI key can live in `secrets/smtp_password` and
  `secrets/ai_api_key`; `CENACLE_AI_TIMEOUT`, `CENACLE_LOG_LEVEL`, `IDP_LOG_LEVEL` and the
  session lifetimes can be set in `.env.prod`.
- Helm: `ai.timeout` and the optional `ai-api-key` key of the Secret.

### Changed

- Images are pulled from the project's registry, `git.calaixo.com:5050/calaxio/cenacle`, by
  default (compose and Helm); the proxy image is pulled too instead of built on the host.
- An empty setting no longer conflicts with its `_FILE` form.
- Cenacle ID's metrics use `@prometheus-io/client`, the successor of `prom-client`.
- Dependency updates.
- Documentation reviewed against the code: installation settings, outbound connections,
  backups (everything that holds secrets), upgrade notes, roadmap.

### Fixed

- Compose: `CENACLE_S3_ENDPOINT=` (empty) turns files off, as documented, instead of
  falling back to Garage.
- After jumping to a message, its highlight lasts from when it is in view: a slow device no
  longer uses it up while still scrolling.

## [0.27.1] - 2026-10-23

### Fixed

- Jumping to an older message (from search or a link) could still stop short on phones: the
  list now opens at the message instead of scrolling a list still being measured.

## [0.27.0] - 2026-10-23

Optimization and load tests.

### Added

- A load test of the chat server (`make load`) and a [performance guide](docs/operations/performance.md)
  with its results.
- `CENACLE_DATABASE_MAX_CONNS`: the most database connections one server keeps.

### Changed

- A server keeps up to 25 database connections by default (was one per CPU): about 55%
  more messages per second under load, and history and search answer several times faster.
- Live events are prepared once for all connections of a server.
- The web app's first download is about 1.6 MB of JavaScript instead of 4.4 MB; code
  highlighting, emoji data and admin pages load when needed.

## [0.26.0] - 2026-10-23

Security testing.

### Added

- An authorization test calls every API operation that names a resource as someone
  outside the workspace, and as a member outside the private channel; none may succeed.
- Fuzzing of what people type (search terms, mentions, encrypted envelopes, links,
  reminders) on every change, and `ci/zap.sh` for an OWASP ZAP scan of an installation.
- The proxy sends `Strict-Transport-Security`; the web app sends
  `Cross-Origin-Resource-Policy`. A [security overview](docs/security/README.md) with the
  threat model and an operators' checklist.

### Fixed

- Voice messages and video clips could not record behind the production web server, whose
  `Permissions-Policy` turned off the microphone and camera.
- `/remind` with some unusual characters failed instead of answering.
- A text such as `http://%` no longer counts as a link to preview.
- On phones, choosing a search result closes the search so the message shows.
- Loading older messages could shift the list by a row (day separators move), which made
  jumping to an older message stop short.

## [0.25.0] - 2026-10-23

Federation between Cenacle servers.

### Added

- Connect a workspace to a workspace of another Cenacle server with an invitation code, and
  share channels with it: messages, replies, edits, deletions and reactions go both ways,
  signed with the connection's secret (ADR 0030).
- People of the other server appear as guests named after their server.

## [0.24.0] - 2026-10-23

Optional, self-hosted AI.

### Added

- AI features with a model you run (Ollama, vLLM, llama.cpp, LocalAI, … through the
  OpenAI-compatible API), off unless the operator configures a model and a workspace turns
  it on; while off, the app shows nothing about AI (ADR 0029).
- Summaries of channels and threads, rewriting of drafts, and answers to questions from the
  messages you can read, with their sources.

### Fixed

- The composer's buttons wrap below the text on narrow screens instead of squeezing it.
- Jumping to an older message (from search or a link) could stop short on a busy device
  while older pages were still arriving.

## [0.23.0] - 2026-10-22

Compliance and access control.

### Added

- Retention: how many days messages are kept, for a workspace and per channel (ADR 0028).
- Legal holds that keep people's or channels' messages from any deletion, and an
  eDiscovery export of messages (deleted ones included) as JSON lines; both audited.
- Classification banners at the top of channels.
- Member attributes (e.g. department) and channel access rules that require them.
- End-to-end encrypted channels with a passphrase their members share; the server only
  stores what it cannot read.

## [0.22.0] - 2026-10-22

Collaboration.

### Added

- Channel tabs next to the messages: canvases, lists and links, added by people who can
  post (ADR 0027).
- Canvases: pages of Markdown written together, one editor at a time, with a warning
  instead of overwriting someone's save.
- Lists with typed columns (text, number, choice, status, person, date, checkbox), as a
  table or as a board; cards move by dragging or with "Move to".
- Task lists, and a **Tasks** view with your approvals, forms and the rows assigned to you.

## [0.21.0] - 2026-10-22

Automation.

### Added

- Workflows: a trigger (from the composer, someone joining a channel, a reaction, a
  keyword, a schedule or a webhook) and steps (post in a channel, send a direct message,
  ask for a form, ask for approval, wait, send to a web address), with variables, built
  without code by workspace owners and admins (ADR 0026).
- Forms, filled in from the composer or in a workflow; their answers show as a card.
- Approvals: approvers decide on a card in their conversation with the Cenacle bot.

### Changed

- Cenacle is now licensed under the GNU Affero General Public License v3.0
  (`AGPL-3.0-only`); `packages/core` stays under the Apache License 2.0 (ADR 0025).
  Contributions need the Contributor License Agreement (`CLA.md`), checked in merge
  requests; the name and logo follow `TRADEMARKS.md`.

## [0.20.1] - 2026-10-22

### Security

- Cenacle ID runs on Node.js 24.22.1, which fixes an out-of-bounds write in the bundled
  Brotli decoder (CVE-2026-111497, high): a malicious or compromised identity provider
  could send a crafted Brotli response to Cenacle ID's outgoing requests (OpenID Connect
  discovery, tokens, keys). The release also fixes Node.js's TLS hostname and DNS issues of
  October 2026. The chat server, the web app and the proxy were not affected.

## [0.20.0] - 2026-10-22

Richer communication.

### Added

- Link previews: the first link of a message shows the page's title, description and
  picture, fetched by the server from public addresses only and served by Cenacle; its
  author can remove it. `CENACLE_LINK_PREVIEWS=false` turns them off.
- Voice messages (with a waveform) and short video clips recorded in the app.
- Forwarding a message, with a comment, to another channel or conversation; "Copy link".
- Custom emoji (`:name:` in text and reactions) and stickers, added by workspace members.
- Mentions of many: `@channel`/`@everyone`, `@here` (people online), `@admins`, `@owners`;
  they count and notify as mentions, and a larger channel asks before notifying everyone.
- Burn-on-read messages in direct and group conversations: each recipient reveals the
  text once, for a set time; it is not kept in search, notifications or pins.

### Fixed

- Images are published to each registry with skopeo; GitLab's registry rejected
  buildkit's pushes of `cenacle-idp` and `cenacle-web` 0.19.0.

## [0.19.0] - 2026-10-22

Community and moderation.

### Added

- Forum channels: posts with titles and tags, answered in their threads.
- Polls: single or multiple choice, anonymous if wished, closing on time or by hand.
- Events with RSVPs and a reminder 15 minutes before.
- Moderation: slow mode, member timeouts, AutoMod rules (words, mention floods, links),
  reports and the moderation queue.
- A workspace welcome with rules and suggested channels for new members.
- Playbooks: repeatable checklists run in channels.
- An instance-wide announcement banner and terms of service everyone accepts.

### Changed

- CI runs on the project's GitLab with a self-hosted runner (ADR 0022,
  `docs/operations/ci.md`); GitHub is a mirror without workflows.

### Fixed

- Go integration tests no longer race to create the `unaccent` extension on a fresh
  test database.
- Jumping to a search result highlights the message once it is in view, not before
  (on slow machines the highlight could end before the message showed).

## [0.18.0] - 2026-10-22

Threads, pins and saved messages.

### Added

- Threads: reply to a message in the right panel, optionally also in the channel; replies
  show under the message with who replied and when. Follow or stop following threads.
- Threads view with new replies and mentions, Activity (mentions, replies, reactions) and
  All unreads across a workspace's channels.
- Pin messages to a channel (listed in the channel details).
- Save messages for later, with reminders from the Cenacle bot, and mark them done.
- Links to messages (`/c/<channel>?m=<message>`) open the message, or its thread.

### Changed

- Others' messages now have a menu too (reply, save, pin).
- Replies in followed threads notify like mentions.

### Upgrade notes

- See [docs/upgrade](docs/upgrade/README.md#0180).

## [0.17.0] - 2026-10-22

Search and notifications.

### Added

- Search messages and files of your channels and conversations: accents and case do not
  matter, words match their beginnings, `-word` leaves it out; filters for where, from
  whom, when, with files or links; results jump to the message (Ctrl+Shift+F / ⌘⇧F).
- Notification settings: what notifies in channels, pause for a while, quiet hours, ten
  sounds plus your own, volume, desktop notifications.
- Mute channels, conversations and workspaces for a while or until you unmute; muted
  channels are dimmed and still show mentions.
- E-mail about missed mentions and direct messages (needs SMTP).
- Web push on devices where Cenacle is closed (off by default; needs the browsers' push
  services).

### Upgrade notes

- See [docs/upgrade](docs/upgrade/README.md#0170).

## [0.16.0] - 2026-10-22

Appearance.

### Added

- Theme presets (Cenacle, Graphite, Ocean, Forest, Sunset, Rose, High contrast), all
  checked against WCAG 2.2 AA in light and dark; workspaces set a default.
- Fonts: ten text and ten code fonts bundled, six font templates, own combinations, text
  size and line spacing; fonts people upload for themselves.
- Code blocks: six color themes, line numbers, wrapping and ligatures.
- Appearance settings follow people to every device.
- Administrators replace the sign-in page texts and a few chat texts, per language.

### Changed

- Image builds retry downloading pnpm.

### Upgrade notes

- See [docs/upgrade](docs/upgrade/README.md#0160).

## [0.15.0] - 2026-10-22

Profiles and settings.

### Added

- Profile pictures (animated GIFs too, still for people who reduce motion), from the
  company directory unless people choose their own.
- @usernames for everyone (the directory's sign-in name for directory accounts).
- Profile cards: picture with presence, name, @username, custom status, local time, last
  seen and address; "Edit profile" for oneself, "Message" for others.
- Custom status with an emoji and/or text, suggestions and recent ones, clearing itself
  after a chosen time; shown next to names in messages and member lists.
- Last seen while offline, which people may hide; local time from the browser's time zone.
- Workspace description and icon.
- Local Cenacle ID accounts change their name on the account page.

### Upgrade notes

- See [docs/upgrade](docs/upgrade/README.md#0150).

## [0.14.0] - 2026-10-22

Identity: company directories, other identity providers, passkeys, an admin panel and
guests.

### Added

- Sign-in with Active Directory and LDAP directories (Cenacle ID): directory passwords,
  nested groups, administrator and guest filters, and synchronization that deactivates people
  who left and ends their sessions. Sign-in accepts a sign-in name or an e-mail address.
- Sign-in with other identity providers over OpenID Connect or SAML 2.0 (Entra ID, Okta,
  Keycloak, Google Workspace, AD FS…), with their groups and roles.
- Passkeys: add them on the account page and sign in without a password.
- The Cenacle ID admin panel (`/account/admin`): accounts, directories (test, preview,
  synchronize, history) and identity providers.
- Directory groups in the chat: map them to workspaces with a role and to private channels,
  optionally managed by groups (members are exactly the people of the groups).
- Guests: they see only their channels and the people in them.
- Several chat administrators: the configured one and those from the directory or provider.
- `cenacle-idp users admin|no-admin` and `users create --admin`.

### Fixed

- Unread counts that arrived while the channel list reloaded could come back.

### Upgrade notes

- See [docs/upgrade](docs/upgrade/README.md#0140).

## [0.13.0] - 2026-10-22

Scaling and operations: several instances, metrics and traces, backups with point-in-time
recovery, a Helm chart, offline installs and imports from Mattermost and Slack.

### Added

- Several chat server instances behind Caddy (`--scale server=N`), with requests and
  WebSockets balanced across them; a drain delay before shutdown for rolling upgrades.
- Prometheus metrics (`CENACLE_METRICS_ADDR`, `IDP_METRICS_PORT`) and OpenTelemetry traces
  (`OTEL_EXPORTER_OTLP_ENDPOINT`); logs carry trace ids.
- Optional observability stack (`observability.yml`): Prometheus, Tempo, Loki, Alloy and
  Grafana with a Cenacle dashboard.
- Optional continuous archiving with WAL-G (`backup.yml`) and a documented restore.
- `cenacle-server status` and `cenacle-server support-bundle`.
- Helm chart (`deploy/helm/cenacle`) and a Kubernetes guide.
- Offline bundles of every image (`deploy/airgap`).
- `cenacle-server import mattermost|slack`: a one-time import of another chat's history
  from its export files; imported people take over their accounts at first sign-in.

### Fixed

- People who joined at their first sign-in did not appear in open member lists (and could
  not be mentioned) until a reload.
- Characters typed quickly right after picking a command or a mention could land before it.
- Large downloads were cut off by the server's write timeout.

### Upgrade notes

- See [docs/upgrade](docs/upgrade/README.md#0130).

## [0.12.0] - 2026-10-22

Files: uploads, previews, a viewer and the channel's files.

### Added

- Attach files to messages (button, drag and drop, paste), up to ten per message and
  100 MB each by default, with upload progress, removal and retry; a message can be files
  only.
- Image previews (with EXIF orientation) and a viewer with keyboard navigation; other files
  as cards with a download link; the channel's files in its details panel.
- Bundled Garage object store in the compose stack; any S3 service can be used instead.
- Optional virus scanning with ClamAV (`--profile clamav`, `CENACLE_CLAMAV_ADDR`).
- Bots can upload and read files.

### Security

- Uploads go straight to the object store with a per-file signed form (exact key and
  size); downloads are checked by the server and served sandboxed, never as pages of the
  app; images are recognized by their content.

### Upgrade notes

- See [docs/upgrade](docs/upgrade/README.md#0120): run `gen-secrets.sh` again,
  new `garage` service, migration `00013_files`.

## [0.11.0] - 2026-10-22

Slash commands, event subscriptions, scheduled messages and reminders; GitLab and
Alertmanager.

### Added

- Slash commands: type `/` for suggestions. Built-ins `/remind`, `/join`, `/leave`,
  `/topic`, `/me` and `/shrug`; bots add their own, answered only to the caller or posted
  in the channel. `//text` sends text that starts with a slash.
- Send later: schedule a message from the composer (in an hour, tomorrow morning, next
  Monday or any time) and cancel it until it goes out.
- Reminders: `/remind me in 10m …`, `at 15:30 …`, `tomorrow …` (also Turkish: `10 dk
sonra`, `yarın`) arrive as a direct message from Cenacle.
- Event subscriptions: bots receive signed deliveries of messages and reactions in their
  channels, with retries, a delivery log and sending again.
- Bot token rotation with an overlap during which the old token keeps working.
- GitLab and Alertmanager incoming webhooks.

### Security

- Requests to bots go through one client that refuses internal addresses (SSRF) unless
  `CENACLE_EGRESS_ALLOW` lists them, never follows redirects and signs every request
  (`X-Cenacle-Signature`).
- Commands count against the per-person message rate limit; a person can have at most 200
  messages and reminders waiting.

### Fixed

- A message that arrived while a channel was first loading could be missing until reload.

### Upgrade notes

- See [docs/upgrade](docs/upgrade/README.md#0110): migration
  `00012_commands_subscriptions_scheduling`, new setting `CENACLE_EGRESS_ALLOW`.

## [0.10.1] - 2026-10-21

Security and reliability fixes from a review of 0.7 to 0.10.

### Security

- Webhook addresses (which carry their secret) no longer appear in the access log.
- Cenacle ID: the attempts of a second step can no longer be renewed by entering the
  password again, are counted atomically, and an account allows 10 failed second steps per
  15 minutes.
- Links that imitate mentions no longer render as mention chips.

### Fixed

- A live event whose transaction committed after a later one could be dropped by the
  outbox relay.
- Back-channel logout can be retried when ending the sessions failed.
- Webhooks respect announcement channels and cannot be created for archived channels;
  reusing a nonce for another message answers 409.

## [0.10.0] - 2026-10-21

Bots with scoped tokens, incoming webhooks and Jira.

### Added

- Bots: workspace owners and admins create bots, give them tokens scoped to reading or
  writing messages, and disable or enable them; bot messages carry a badge.
- Incoming webhooks: a secret address posts into a channel as the bot (JSON text and
  cards, or Jira events).
- Jira: issues created, changed, deleted and comments become cards in a channel
  ([guide](docs/integrations/README.md#jira)).

### Upgrade notes

- See [docs/upgrade](docs/upgrade/README.md#0100): migration
  `00011_bots_and_webhooks`.

## [0.9.0] - 2026-10-21

Markdown, mentions, reactions and message cards; a transactional outbox for live events; background jobs on River.

### Added

- Markdown in messages (bold, italics, links, lists, quotes, tables, code) with code
  highlighting; raw HTML and remote images are not shown.
- Mentions: type "@" to pick a member; mentioned people see the message highlighted and
  a mention count on the channel.
- Reactions with an emoji picker (emoji data served by Cenacle itself).
- Message attachments (cards with title, link, text and fields) through the API.

### Changed

- Live events go through a transactional outbox: they are written with the change and
  cannot be lost when Valkey is briefly unavailable.
- Purging deleted messages and expired sessions runs as background jobs (River), once
  across all instances.

### Upgrade notes

- See [docs/upgrade](docs/upgrade/README.md#090): migration
  `00010_outbox_reactions_mentions`; `migrate up` now also creates River's tables.

## [0.8.0] - 2026-10-21

Two-step verification, signed-in devices with sign out everywhere, back-channel logout and audit logs.

### Added

- Two-step verification at Cenacle ID: an authenticator app code (TOTP) after the
  password, one-time recovery codes, and an account page (`/account`) to turn it on and off
  and see recent activity.
- Settings in the app: signed-in devices, signing one out, and "Sign out everywhere"
  (optionally keeping this device); open apps of ended sessions sign out at once.
- Back-channel logout: signing out at Cenacle ID ends the chat sessions of that sign-in.
- Audit logs: account events at Cenacle ID; role changes, removals, invitations, channel
  changes and moderation per workspace (`GET /api/workspaces/{id}/audit`).

### Fixed

- A session that ended while the app was open (signed out elsewhere, expired) could loop
  between the app and the sign-in page instead of showing the sign-in page.

### Upgrade notes

- See [docs/upgrade](docs/upgrade/README.md#080): migrations
  `0002_mfa_and_audit` (Cenacle ID) and `00009_sessions_and_audit` (chat), and the
  `backchannel_logout_uri` of the chat client.

## [0.7.0] - 2026-10-21

Direct and group conversations, unread counts, presence and typing notices.

### Added

- Direct and group conversations (up to 9 people): "Direct messages" in the sidebar, the
  same people always meet in the same conversation; only they see it.
- Unread messages: counts for conversations, bold and a dot for channels, a mark on the
  workspace rail, a "New messages" line; reading on one device clears the others.
- Presence (online, away, do not disturb, offline) on conversations and a status menu on
  your avatar.
- "… is typing" under the composer.

### Changed

- Workspace owners and admins do not see conversations of others (they see private
  channels as before). Channel names cannot start with `direct:` or `group:`.

### Upgrade notes

- See [docs/upgrade](docs/upgrade/README.md#070): reversible migration
  `00008_direct_messages_and_unread`.

## [0.6.0] - 2026-10-21

Workspaces with owners, admins and members, invitation links, channel manager appointments.

### Added

- Workspaces: the rail lists them, `/w/<id>` opens one. Everything that existed moves to
  the default workspace, which everyone joins.
- Roles per workspace (owner, admin, member): owners and admins create channels, organize
  categories and manage channels; owners manage the owner role; at least one owner stays.
- Invitation links with validity and use limit; `/invite/<token>` joins a workspace.
- Channel managers appoint other managers.
- `IDP_LOGIN_RATE_LIMIT` sets Cenacle ID's sign-in attempts per address and minute.

### Changed

- `CENACLE_ADMIN_EMAIL` names the instance administrator, who creates workspaces and owns
  the default workspace.
- API: listing and creating within a workspace take `workspace_id`; the session reports
  `create_workspaces` instead of `create_channels`.

### Fixed

- Live messages in the channels of a workspace one just joined arrive without a reconnect.

### Upgrade notes

- See [docs/upgrade](docs/upgrade/README.md#060): reversible migration
  `00007_workspaces`.

## [0.5.0] - 2026-10-21

Editing and deleting messages, channel settings and archiving, categories, quick switcher.

### Added

- Edit your messages (marked as edited) and delete them with Undo; channel managers can
  delete any message in their channels. Deleted messages are removed for good after 5
  minutes.
- Channel settings for managers: rename, topic, visibility, archive (read-only, out of the
  sidebar, restorable).
- Categories set by the administrator group channels in everyone's sidebar.
- Quick switcher: Ctrl/⌘+K jumps to a channel by name.

### Upgrade notes

- See [docs/upgrade](docs/upgrade/README.md#050): reversible migration
  `00006_channel_and_message_management`.

## [0.4.0] - 2026-10-21

Live chat in channels: messages over WebSocket, channel membership, channels for everyone
set at installation, public and private channels.

### Added

- Live chat: channels (a General channel is created), messages with cursor pagination,
  idempotent sending with a client nonce and a per-user rate limit.
- Live events over WebSocket: single-use tickets, a Valkey stream shared by all server
  instances, resuming after the last event, resync when events were missed, bounded queues,
  heartbeats; connections close when the session ends.
- `@cenacle/core`: reconnecting realtime client (backoff with jitter, online/offline and
  tab visibility).
- Web: channels in the URL, virtualized timeline with grouped messages and day separators,
  optimistic sending with retry, drafts per channel, connection notices.
- Channel membership: browse all channels, join and leave (with undo); messages and live
  events reach members only.
- Channels for everyone from the installation: `CENACLE_ANNOUNCEMENT_CHANNEL` (default
  `Central`: mandatory, only the administrator posts) and `CENACLE_DEFAULT_CHANNELS`
  (default `General`).
- One administrator until roles arrive: the verified account of `CENACLE_ADMIN_EMAIL`
  creates channels (optionally for everyone) and posts in announcement channels.
- Public and private channels. Private channels are visible to their members only; their
  manager (the creator, and the administrator) adds and removes people. Members list in the
  details panel; visibility can be changed by a manager; people search by name or e-mail.

### Changed

- The sample channels, categories and direct messages of the shell are gone; the sidebar
  lists the real channels.
- Channel names are display names ("Central", "Release notes"), unique regardless of case,
  shown without "#".
- The web development server listens on port 15173 (5173 clashes with other projects).

### Fixed

- The composer no longer shows a scrollbar for a single line, and its send button no
  longer covers the scrollbar of long text.

### Upgrade notes

- See [docs/upgrade](docs/upgrade/README.md#040): reversible migrations
  `00003_channels_messages`, `00004_channel_membership` and `00005_private_channels`; set
  `CENACLE_ADMIN_EMAIL`.

## [0.3.0] - 2026-10-21

The chat signs users in with Cenacle ID and keeps its own sessions; the brand identity
replaces the placeholder look.

### Added

- Brand identity (Forest & Brass, Fraunces wordmark, "Upper room" icon): logo files,
  theme-aware favicon, app icons and web manifest; `make brand` renders the PNG/ICO icons.
- `Logo` and `AppIcon` components in `@cenacle/ui/brand`; brand section in the component
  gallery; brand guide in `docs/brand`.
- Fraunces display font (self-hosted) for brand headlines.
- Token contrast check (`scripts/check-contrast.mjs`) in `pnpm lint` and CI.
- Sign-in to the chat with Cenacle ID: authorization code flow with PKCE, nonce and issuer
  checks, sign-in state bound to the browser and usable once. Users are created on first
  sign-in and keyed by the IdP subject.
- Chat sessions: opaque tokens stored as hashes, idle timeout (7 days) and maximum age
  (30 days), `HttpOnly` `SameSite=Lax` cookie (`__Host-` over https) or bearer token;
  same-origin check for state-changing cookie requests. `GET /api/session`,
  `POST /api/auth/logout` (also ends single sign-on via the Cenacle ID sign-out page).
- Spec-first chat API: `server/api/openapi.yaml`, Go server interface (oapi-codegen) and
  TypeScript types and client in `@cenacle/core`.
- Web: sign-in page with explained outcomes, session-required app routes that return to the
  same place after sign-in, signed-in user and sign-out in the sidebar.
- `make dev-user` creates a development account; `make test-e2e-stack` signs in end to end
  with Cenacle ID, chat server and web app running (also in CI).

### Changed

- Light theme on Paper with Forest text, dark theme on Night with Bone text; brass
  accent (`--accent-brand`) for primary buttons and focus rings; form control outlines
  reach 3:1. The Cenacle ID pages use the same brand.
- The Vite dev server proxies `/api` to the chat server; the development OIDC client of
  the chat now redirects to `http://localhost:15173/api/auth/callback`.

### Upgrade notes

- See [docs/upgrade](docs/upgrade/README.md#030): new `prod.yml`, reversible
  migration `00002_users_sessions`.

## [0.2.0] - 2026-10-21

Cenacle ID becomes an OpenID Provider. The chat server signs in with it from v0.3.

### Added

- OpenID Provider (oidc-provider 9) with an RFC 9700 profile: authorization code with
  PKCE (S256) for every client, exact redirect URIs, `client_secret_basic`, short-lived
  codes and tokens, RP-initiated logout, userinfo, revocation.
- Accounts with Argon2id passwords (NIST SP 800-63B-4 policy) and a CLI:
  `cenacle-idp users create|set-password|disable|enable`.
- Token signing keys (RS256) encrypted at rest, rotation with a grace period:
  `cenacle-idp keys list|rotate|prune`.
- Database migrations for Cenacle ID: `cenacle-idp migrate up|down`.
- Sign-in, error and logout pages in English and Turkish on the Cenacle design tokens,
  strict CSP, no third-party requests; one message for unknown accounts and wrong
  passwords, rate limiting, cross-site post protection.
- Registered clients from a JSON file with `${VARIABLE}` placeholders and secret files.
- End-to-end OIDC tests in a real browser and integration tests on PostgreSQL in CI.

### Changed

- `@cenacle/ui` exposes `tokens.css` (framework-free design tokens).
- `BlueOak-1.0.0` is an allowed dependency license.

### Upgrade notes

- See [docs/upgrade](docs/upgrade/README.md#020): new secrets and the `idp-migrate` step.

## [0.1.1] - 2026-10-21

First release with published container images.

### Added

- Container images on GHCR (`ghcr.io/barisshn35/cenacle-{server,idp,web,proxy}`) for
  amd64 and arm64, with build provenance and an SBOM, published by CI for version tags
  only after every check has passed.
- `CENACLE_TLS_MODE` for the production proxy: Let's Encrypt (default), your own
  certificate files, or Caddy's internal CA.
- Installation and firewall guide (`docs/install`).

### Fixed

- The Go toolchain is pinned to 1.26.10, so CI no longer builds and scans with Go 1.26.0
  (standard library vulnerabilities reported by govulncheck).
- `deploy/compose/.env.prod.example` is now part of the repository.

### Changed

- Cenacle ID images build on the native platform (faster arm64 builds).
- Dependabot proposes only patch updates for versions tied to the runtime (Node, Go).

### Upgrade notes

- No database migrations. Set `CENACLE_VERSION=0.1.1`; optionally add `CENACLE_TLS_MODE`.

## [0.1.0] - 2026-10-21

First skeleton release. Nothing user-facing beyond a shell with placeholder data.

### Added

- Monorepo: pnpm workspaces (web, idp, packages) and a Go module for the chat server;
  Makefile with pinned tools; ESLint + Prettier, golangci-lint.
- Chat server (Go): validated env/file configuration, structured logs, chi router,
  request IDs, RFC 9457 problem details for all errors, `/healthz` and `/readyz`
  (PostgreSQL + Valkey), graceful shutdown, embedded goose migrations behind an advisory
  lock, sqlc setup.
- Cenacle ID (Node.js/TypeScript, Fastify): configuration, separate database pool,
  `/healthz` and `/readyz`, problem details.
- Design system (`@cenacle/ui`): OKLCH tokens (light/dark), chat tokens, WCAG 2.2 target
  size tokens, density, own theme provider, bundled fonts, Base UI primitives;
  `ConfirmDialog` (S2/S3), undo toast, `ErrorState`/`InlineError`; EN/TR texts.
- `@cenacle/core`: per-channel draft storage in IndexedDB, problem type, OpenAPI
  generation placeholder.
- Web app: shell with workspace rail, channel sidebar, message area and details panel;
  theme, density and language selectors; development-only component gallery.
- Tests: unit tests for all packages; Playwright target size (fine/coarse), axe WCAG 2.2 AA,
  keyboard flows and "no external requests" checks.
- Infrastructure: development compose stack (PostgreSQL 18, Valkey 9, test OpenLDAP,
  Mailpit), production compose skeleton (Caddy with automatic TLS, secrets, hardened
  non-root containers), multi-arch Dockerfiles.
- CI (GitHub Actions): lint, tests (Node 24 and 26), e2e, govulncheck, gitleaks, trivy,
  license policy, multi-arch image builds; Dependabot.
- Documentation: README, ADR 0001, glossary, upgrade and backup guides, contribution and
  security policies.

### Upgrade notes

- Baseline release; the database migration history starts here.

[Unreleased]: https://github.com/barisshn35/cenacle/compare/v0.32.0...HEAD
[0.32.0]: https://github.com/barisshn35/cenacle/compare/v0.31.0...v0.32.0
[0.31.0]: https://github.com/barisshn35/cenacle/compare/v0.30.0...v0.31.0
[0.30.0]: https://github.com/barisshn35/cenacle/compare/v0.29.0...v0.30.0
[0.29.0]: https://github.com/barisshn35/cenacle/compare/v0.28.0...v0.29.0
[0.28.0]: https://github.com/barisshn35/cenacle/compare/v0.27.1...v0.28.0
[0.27.1]: https://github.com/barisshn35/cenacle/compare/v0.27.0...v0.27.1
[0.27.0]: https://github.com/barisshn35/cenacle/compare/v0.26.0...v0.27.0
[0.26.0]: https://github.com/barisshn35/cenacle/compare/v0.25.0...v0.26.0
[0.25.0]: https://github.com/barisshn35/cenacle/compare/v0.24.0...v0.25.0
[0.24.0]: https://github.com/barisshn35/cenacle/compare/v0.23.0...v0.24.0
[0.23.0]: https://github.com/barisshn35/cenacle/compare/v0.22.0...v0.23.0
[0.22.0]: https://github.com/barisshn35/cenacle/compare/v0.21.0...v0.22.0
[0.21.0]: https://github.com/barisshn35/cenacle/compare/v0.20.1...v0.21.0
[0.20.1]: https://github.com/barisshn35/cenacle/compare/v0.20.0...v0.20.1
[0.20.0]: https://github.com/barisshn35/cenacle/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/barisshn35/cenacle/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/barisshn35/cenacle/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/barisshn35/cenacle/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/barisshn35/cenacle/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/barisshn35/cenacle/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/barisshn35/cenacle/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/barisshn35/cenacle/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/barisshn35/cenacle/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/barisshn35/cenacle/compare/v0.10.1...v0.11.0
[0.10.1]: https://github.com/barisshn35/cenacle/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/barisshn35/cenacle/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/barisshn35/cenacle/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/barisshn35/cenacle/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/barisshn35/cenacle/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/barisshn35/cenacle/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/barisshn35/cenacle/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/barisshn35/cenacle/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/barisshn35/cenacle/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/barisshn35/cenacle/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/barisshn35/cenacle/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/barisshn35/cenacle/releases/tag/v0.1.0

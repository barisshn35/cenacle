# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Upgrade instructions live in [docs/upgrade](docs/upgrade/README.md).

## [Unreleased]

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

[Unreleased]: https://github.com/barisshn35/cenacle/compare/v0.15.0...HEAD
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

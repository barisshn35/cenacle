# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Upgrade instructions live in [docs/upgrade](docs/upgrade/README.md).

## [Unreleased]

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

[Unreleased]: https://github.com/barisshn35/cenacle/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/barisshn35/cenacle/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/barisshn35/cenacle/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/barisshn35/cenacle/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/barisshn35/cenacle/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/barisshn35/cenacle/releases/tag/v0.1.0

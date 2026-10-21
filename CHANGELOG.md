# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Upgrade instructions live in [docs/upgrade](docs/upgrade/README.md).

## [Unreleased]

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

[Unreleased]: https://github.com/barisshn35/cenacle/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/barisshn35/cenacle/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/barisshn35/cenacle/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/barisshn35/cenacle/releases/tag/v0.1.0

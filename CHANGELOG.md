# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Upgrade instructions live in [docs/upgrade](docs/upgrade/README.md).

## [Unreleased]

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

[Unreleased]: https://github.com/barisshn35/cenacle/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/barisshn35/cenacle/releases/tag/v0.1.0

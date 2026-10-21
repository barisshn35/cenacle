# Contributing to Cenacle

Thanks for your interest in Cenacle. This document describes how to work on the code base.

## Ground rules

- Be kind; see the [Code of Conduct](CODE_OF_CONDUCT.md).
- Report security issues privately; see [SECURITY.md](SECURITY.md).
- Keep changes small and focused. One logical change per commit.

## Developer Certificate of Origin (DCO)

Every commit must be signed off, certifying that you wrote the change or have the
right to submit it under the project license
([developercertificate.org](https://developercertificate.org/)):

```sh
git commit -s -m "feat(server): add readiness probe"
```

This appends `Signed-off-by: Your Name <you@example.com>` to the commit message.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/) in English:
`feat`, `fix`, `docs`, `chore`, `build`, `ci`, `test`, `refactor`, `perf`.
Scope is the component: `server`, `idp`, `web`, `ui`, `core`, `deploy`.

Every commit must build and pass the tests.

## Getting started

Requirements: Go 1.26, Node.js 24 (see `.nvmrc`), pnpm via Corepack, Docker with Compose v2.

```sh
corepack enable
pnpm install
make tools          # pinned sqlc / golangci-lint binaries into ./.bin
cp .env.example .env
make up             # postgres, valkey, ldap, mailpit
make dev-server     # Go chat backend
make dev-idp        # identity server
make dev-web        # web app
```

Before opening a pull request run:

```sh
make lint test licenses build
```

## Dependencies and licenses

Only permissively licensed dependencies are accepted: MIT, BSD, ISC, Apache-2.0,
MPL-2.0 (file-level), 0BSD, Unlicense, BlueOak-1.0.0. Commercial/closed, unclear-license and linked
GPL/AGPL libraries are not accepted. `make licenses` enforces this policy and CI fails
on a violation. See `docs/adr/0001-monorepo-and-tooling.md` for the exact allow lists.

Community UI components must carry a header comment with source URL, author and license.

## Architecture decisions

Significant decisions (new dependency, schema change, security-relevant design) are
recorded as short ADRs in `docs/adr/NNNN-title.md`.

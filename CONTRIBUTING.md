# Contributing to Cenacle

Thanks for your interest in Cenacle. This document describes how to work on the code base.

## Ground rules

- Be kind; see the [Code of Conduct](CODE_OF_CONDUCT.md).
- Report security issues privately; see [SECURITY.md](SECURITY.md).
- Keep changes small and focused. One logical change per commit.

## License and Contributor License Agreement (CLA)

Cenacle is licensed under the GNU Affero General Public License v3.0 (`AGPL-3.0-only`);
`packages/core` (the API and WebSocket client) is under the Apache License 2.0, so
applications and bots can embed it freely. New files carry the same SPDX header as the
files around them.

Before your first pull request is accepted, sign the [CLA](CLA.md): add a line with
your commit e-mail to [`cla/signatures.txt`](cla/signatures.txt) in a signed-off commit.
You keep the copyright in your work; the CLA lets the project distribute it under its
open-source licenses and other terms. CI checks every commit of a pull request
(`ci/check-cla.sh`): it is signed off with the commit author's own e-mail address, and
that address is in the list. The names and logo are covered by the
[trademark policy](TRADEMARKS.md).

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

Requirements: Go 1.26, Node.js 26 LTS (see `.nvmrc`), pnpm (`npm install -g pnpm`; it runs the version `package.json` names), Docker with Compose v2.

```sh
npm install -g pnpm
pnpm install
make tools          # pinned sqlc, oapi-codegen, golangci-lint, go-licenses, govulncheck, helm
cp .env.example .env
make up             # postgres, valkey, ldap, mailpit
make dev-server     # Go chat backend
make dev-idp        # identity server
make dev-web        # web app
```

Before opening a merge request run:

```sh
make lint test licenses build
```

## Dependencies and licenses

Only permissively licensed dependencies are accepted: MIT, MIT-0, BSD, ISC, Apache-2.0,
MPL-2.0 (file-level), 0BSD, Unlicense, BlueOak-1.0.0 (fonts: OFL-1.1). Commercial/closed, unclear-license and linked
GPL/AGPL libraries are not accepted. `make licenses` enforces this policy and CI fails
on a violation. See `docs/adr/0001-monorepo-and-tooling.md` for the exact allow lists.

Community UI components must carry a header comment with source URL, author and license.

## Translations

How the texts are organized and how to add a language: [docs/translations.md](docs/translations.md).

## Architecture decisions

Significant decisions (new dependency, schema change, security-relevant design) are
recorded as short ADRs in `docs/adr/NNNN-title.md`.

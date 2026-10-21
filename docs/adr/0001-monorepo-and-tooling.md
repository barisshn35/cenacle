# 0001. Monorepo, tooling and v0.1 decisions

- Status: accepted
- Date: 2026-10-21

## Context

Cenacle starts from an empty repository. v0.1 sets up the skeleton of three services
(chat server, Cenacle ID, web app), the design system foundations, local and production
infrastructure, CI and documentation. Architecture choices (Go chat backend, Node.js IdP,
React SPA, PostgreSQL 18, Valkey 9, Caddy, Base UI) were decided before this ADR; this
record covers the tooling and the decisions made while implementing v0.1.

## Decisions

### Repository and tooling

1. **One repository, two toolchains.** JavaScript/TypeScript uses pnpm workspaces
   (`web`, `idp`, `packages/*`); the chat server is a separate Go module (`/server`).
   A `Makefile` is the single entry point. The project name is defined once
   (`PROJECT := cenacle` in the Makefile, compose project `cenacle`, npm scope `@cenacle`).
2. **pnpm 12 via Corepack** (`packageManager` field). Its supply-chain policy (minimum
   release age) is kept on: when a dependency was too new, the previous release was pinned
   instead of relaxing the policy. Install scripts are allowed only for `esbuild`
   (`allowBuilds`). All versions are pinned exactly (`saveExact`).
3. **npm packages are private.** `@cenacle/*` packages are `private: true`; the npm scope
   `@cenacle` belongs to someone else. Renaming the scope is a search-and-replace.
4. **ESLint (flat config) + Prettier instead of Biome.** Accessibility is a release
   criterion for Cenacle; `eslint-plugin-jsx-a11y` and the TanStack Query/Router plugins
   have no equivalent in Biome today.
5. **TypeScript 6.0 and ESLint 9.** TypeScript 7 (native compiler) is not yet supported by
   `typescript-eslint` (`<6.1`), and `eslint-plugin-jsx-a11y` does not support ESLint 10.
   Upgrade when both are supported.
6. **Go tools are pinned binaries** in `./.bin` (`make tools`): sqlc (needs cgo, so not a
   `go tool` dependency), golangci-lint v2, go-licenses, govulncheck.
7. **GitHub instead of GitLab.** The kickoff mentioned GitLab CI and a
   `git.calaixo.com` module path; the repository lives on GitHub, so CI is GitHub Actions
   and the Go module path is `github.com/barisshn35/cenacle/server`. Third-party actions
   are pinned to commit SHAs; gitleaks and trivy run from version-pinned images.

### License policy

8. **Project license: Apache-2.0** (default until decided; switching to AGPL-3.0 only
   changes `LICENSE` and the SPDX headers, because dependencies follow the policy below).
9. **Allowed dependency licenses:** MIT, MIT-0, ISC, BSD-2/3-Clause, Apache-2.0, MPL-2.0,
   0BSD, Unlicense. Enforced by `make licenses` (Go: go-licenses, JS: `scripts/check-licenses.mjs`).
   Explicit exceptions:
   - **Fonts:** Geist and Geist Mono (SIL OFL-1.1), bundled from Fontsource. OFL permits
     bundling with any software; only those two packages are allowed.
   - **Development-only data/tooling licenses** (never shipped): CC-BY-4.0
     (e.g. `caniuse-lite`), CC0-1.0, BlueOak-1.0.0, Python-2.0.
   - **Separate processes are not linked code:** Caddy (Apache-2.0) and, from v0.12, Garage
     (AGPL-3.0) run as their own services and are reached over HTTP/S3.

### Chat server

10. chi router, pgx v5 pool, sqlc (generated code is committed, CI checks for drift),
    goose migrations **embedded in the binary** and run by `server migrate up|down|status`
    under a PostgreSQL advisory lock, so concurrent replicas never migrate twice.
11. Configuration uses the standard library only: `CENACLE_*` variables, each also readable
    from `<NAME>_FILE` (Docker secrets); all problems are reported at once.
12. The pgx pool and the Valkey client (`valkey-go`, which dials eagerly) connect lazily, so
    the server starts and reports "not ready" while a dependency is down.
13. **Errors are RFC 9457 problem details** everywhere (unknown routes, wrong methods,
    panics, readiness): `type` (`about:blank` for plain HTTP errors), `title`, `status`,
    `detail`, a stable `code` for clients/i18n and the `request_id`. Dependency error
    details only go to logs.
14. **Request IDs** look like `REQ-XXXXXXXXXXXXXXXX` in both services; an incoming
    `X-Request-ID` is reused only if it matches a safe pattern.

### Web and design system

15. **shadcn/ui "base-nova" on Base UI** as the only primitive layer. Components were
    generated with the shadcn CLI, then adapted: target sizes, i18n labels, local imports,
    our `ThemeProvider` instead of `next-themes`. The few CSS variants they need from
    `shadcn/tailwind.css` are inlined, so the shadcn CLI is never a runtime dependency.
    Class merging uses shadcn's `cn` package (MIT).
16. **Target sizes are tokens** (`--target-min: 24px`, `--target-fine: 28px`,
    `--target-coarse: 44px`); `--target` switches to 44 px on `(pointer: coarse)`.
    Density (`compact`/`comfortable`, default "auto" = comfortable on touch, compact on
    mouse) changes spacing, never target size. Small visuals grow their hit area with the
    `hit-target` utility.
17. **i18n with i18next** (resources bundled, no network); `en` default, `tr` second.
    Component texts live in the `ui` namespace of `@cenacle/ui`.
18. **TanStack Router, code-based.** The `/dev/gallery` route exists in the route tree for
    type safety, but its component, texts and lazy chunk are compiled out of production
    builds (`import.meta.env.DEV`), where the route answers "not found".
19. **No Storybook in v0.1.** The development-only gallery is enough for the target size and
    axe tests and avoids a second build toolchain. The UX plan mentions Storybook; it can be
    added later without changing components.
20. **ConfirmDialog states "This cannot be undone." only when `irreversible` is set.**
    The UX plan allows admin restore within the retention period for some S3 actions
    (e.g. permanent channel delete), so S3 alone must not imply irreversibility.

### Testing

21. Playwright runs a **fine** (desktop) and a **coarse** (touch) project and measures every
    interactive element of the gallery (light/dark x compact/comfortable) and the app shell:
    below 24 px (fine) or 44 px (coarse) fails, below the 28 px goal is reported.
22. **axe-core 4.14.0 ships `target-size` disabled by default** (tags `wcag22aa`, `wcag258`);
    the tests enable it explicitly and run the WCAG 2.0–2.2 A/AA rules.

### Infrastructure

23. **Development ports are non-standard** (15432, 16379, 13389, 11025/18025, 8180, 8190)
    and bound to 127.0.0.1, so Cenacle can share a host with other stacks.
24. **Test LDAP is a small image built from Alpine's `openldap` packages** (non-root, LDIF
    seed). The usual images are unmaintained (osixia) or frozen (bitnami legacy).
25. **Images are minimal and non-root:** server on distroless static (uid 65532) with a
    built-in `healthcheck` command; Cenacle ID as the `node` binary on plain Alpine (no npm,
    Corepack or Yarn at runtime); web and proxy on Alpine with Caddy.
26. **Caddy is compiled from source** (same release, standard modules) with our Go toolchain
    and current `golang.org/x/net`, because the official image carried HIGH advisories
    fixed only in newer Go/x/net. This also avoids Caddy's file capability, which breaks
    `cap_drop: ALL` + `no-new-privileges`.
27. **Production compose** uses file-based secrets (`gen-secrets.sh`; directory 0700, files
    0644 because Compose bind-mounts them for non-root services), an internal data network,
    read-only root file systems, dropped capabilities, and opens ports 80/443 via the
    `net.ipv4.ip_unprivileged_port_start` sysctl instead of capabilities. PostgreSQL keeps
    the minimal capabilities its entrypoint needs to drop privileges.
28. The web CSP allows `style-src 'unsafe-inline'` because positioning libraries (Base UI,
    sonner) set inline styles; scripts are `'self'` only.

## Consequences

- Contributors need Go, Node 24 and Docker; `make tools` and Corepack install the rest.
- Every dependency and image is pinned; Dependabot proposes updates (npm with a cool-down,
  matching pnpm's release-age policy).
- Revisit: TypeScript 7 / ESLint 10 support, Storybook, upstream Caddy releases (switch
  back to the official image when it is current), Node 26 LTS after 2026-10-28.

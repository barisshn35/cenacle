# Releases and support

This page says which Cenacle versions receive fixes, for how long, and how to move from one
supported version to the next. It applies from 1.0.0 on; before that only the latest 0.x
release was supported.

## Two kinds of release

- **Feature releases** (`1.1.0`, `1.2.0`, …) bring new features, roughly every two months.
  Each is supported until the next feature release comes out, and one month after that, so
  that there is time to upgrade.
- **Extended support releases (ESR)** are feature releases chosen to be supported for
  **12 months**. One comes every **6 months**, so two ESRs are always supported and their
  support overlaps by half a year. **1.0 is the first ESR.**

Organizations that want few, planned upgrades follow the ESRs: they upgrade once or twice a
year, from one ESR to the next. Others follow the feature releases.

| Version | Kind    | Released | Supported until                          |
| ------- | ------- | -------- | ---------------------------------------- |
| 1.0     | ESR     | 1.0.0    | 12 months after 1.0.0                    |
| 1.x     | feature | 1.x.0    | one month after the next feature release |

The table grows with each release; the [changelog](../../CHANGELOG.md) names each ESR.

## What a supported version receives

Patch releases (`1.0.1`, `1.0.2`, …) of a supported version contain only:

- fixes of security vulnerabilities (all severities that affect Cenacle as configured by its
  documentation), including updates of dependencies and base images that fix them;
- fixes of bugs that lose or corrupt data, stop people from signing in or sending messages, or
  break an upgrade;
- fixes needed to keep running on the supported platforms below.

They never add features, change the database schema in a way the previous patch cannot read,
or change configuration that works. Upgrading between patches of one version is always safe and
needs no steps beyond replacing the images (or the packages of the desktop app).

## Upgrading between versions

- **Patches** of one version: replace the images; migrations, if any, run by themselves and
  are backward compatible.
- **ESR to the next ESR** (for example 1.0 to 1.6): directly, in one step. Before an ESR is
  released, an installation of the previous ESR's latest patch, with data, is upgraded to it,
  rolled back and restored from backup (the rehearsal of
  [docs/upgrade](../upgrade/README.md)). The ESR's upgrade notes list everything that changed
  since the previous ESR in one place.
- **Feature release to a later one:** directly as well; read the upgrade notes of each version
  in between.

Downgrading is not supported: restore the backup taken before the upgrade instead
([docs/backup](../backup/README.md)).

## Supported platforms

| Component     | Supported                                                         |
| ------------- | ----------------------------------------------------------------- |
| Server images | Linux amd64 and arm64, with Docker Compose v2 or Kubernetes 1.30+ |
| Database      | PostgreSQL 18                                                     |
| Cache         | Valkey 9                                                          |
| Browsers      | the two latest versions of Chrome, Edge, Firefox and Safari       |
| Desktop app   | Windows 10 (1809+) and 11, x64 and arm64; Linux x64 and arm64     |

An ESR keeps the platforms it was released with for its whole support, unless a platform's own
maker ends support for it.

## How fixes are made

Each supported version has a branch, `release-<major>.<minor>` (for example `release-1.0`),
made from its first tag. A fix lands on `main` first and is then copied (cherry-picked) to the
branch of every supported version it affects; CI runs the whole quality gate on each branch,
and each patch is tagged and signed like any release. Security fixes are prepared privately
and published in all supported versions at the same time, with an advisory
([SECURITY.md](../../SECURITY.md)).

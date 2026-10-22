# 0022. CI on a self-hosted GitLab (v0.19)

- Status: accepted (supersedes point 7 of ADR 0001)
- Date: 2026-10-22

## Context

CI ran on GitHub Actions. The free plan's minutes no longer cover the pipeline (Go,
Node 24 and 26, three Playwright suites, security scans and four multi-arch images
per release). The project has its own GitLab, where self-hosted runners cost nothing
per minute.

## Decisions

1. **The primary repository and CI are on the project's GitLab**; GitHub stays as a
   mirror of `main` and the tags, without workflows. The Go module path does not change.
2. **One runner, on a CI disk of its own.** It starts jobs in a Docker engine of its own
   (Docker-in-Docker), apart from anything else running on the host, limited in CPU and
   memory, one job at a time. Its data, build directories and caches live on a separate
   disk.
3. **Jobs share the network of that engine**, so test services started with
   `ci/services.sh` answer on `127.0.0.1`, as on a developer's machine and as the GitHub
   workflow had them. No job runs privileged; a job reaches the CI engine through its
   socket.
4. **The CI image** (`ci/image`) carries Go, Node.js 24 and 26, pnpm, the Docker CLI with
   buildx and Playwright's system libraries; the pipeline builds it once per version.
   Caches (Go modules and builds, pnpm store, Playwright browsers, image layers, trivy's
   database) persist in `/cache`.
5. **Images**: every pipeline builds and scans the amd64 images; a `v*` tag also builds
   arm64 (QEMU) and publishes both to the project's registry, and to GitHub's registry
   when a `GHCR_TOKEN` CI/CD variable is set.

## Consequences

- Pipelines no longer depend on GitHub's minutes; their speed depends on the CI host.
- One runner runs jobs one after another; a second runner can be registered the same way
  (`docs/operations/ci.md`).
- Contributions arrive as merge requests on GitLab; pull requests on the GitHub mirror get
  no CI.

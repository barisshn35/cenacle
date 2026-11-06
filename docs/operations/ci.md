# Continuous integration

The pipeline is `.gitlab-ci.yml` (ADR 0022): lint, tests (Go, Node.js 26,
Playwright end-to-end suites), security scans, license checks and images. It needs a
GitLab runner with the tag `cenacle` set up as below.

## Runner

The runner starts jobs in a Docker engine of its own, so CI never sees the host's
containers, and keeps everything on a dedicated disk (here `/var/lib/cenacle-ci`).

`compose.yml` on the CI host:

```yaml
name: cenacle-ci
services:
  docker:
    image: docker:29.9.2-dind
    privileged: true
    restart: unless-stopped
    environment: { DOCKER_TLS_CERTDIR: '' }
    # The second socket serves jobs that mount /var/run/docker.sock into containers.
    command:
      ['dockerd', '--host=unix:///run/ci-docker/docker.sock', '--host=unix:///var/run/docker.sock']
    volumes:
      - /var/lib/cenacle-ci/docker:/var/lib/docker
      - /var/lib/cenacle-ci/builds:/builds
      - /var/lib/cenacle-ci/cache:/cache
      - socket:/run/ci-docker
    cpus: 8
    mem_limit: 14g
  runner:
    image: gitlab/gitlab-runner:alpine-v19.5.0
    restart: unless-stopped
    volumes:
      - /var/lib/cenacle-ci/runner:/etc/gitlab-runner
      - socket:/run/ci-docker
volumes:
  socket:
```

If the GitLab host name resolves differently inside your network, add it to both services
with `extra_hosts`.

1. In GitLab, create an instance (or project) runner with the tag `cenacle` and copy its
   token.
2. Register it (the token stays out of shell history when read from a file):
   ```sh
   CI_SERVER_TOKEN="$(cat token-file)" docker compose run --rm -e CI_SERVER_TOKEN runner register \
     --non-interactive --url https://<gitlab-host> --executor docker \
     --description cenacle-ci --docker-image cenacle-ci:1
   ```
3. Edit `/var/lib/cenacle-ci/runner/config.toml`: `concurrent = 1`; under `[[runners]]`
   `builds_dir = "/builds"` and `cache_dir = "/cache/gitlab"`; and

   ```toml
   [runners.docker]
     host = "unix:///run/ci-docker/docker.sock"
     image = "cenacle-ci:1"
     network_mode = "host"
     privileged = false
     pull_policy = ["if-not-present"]
     volumes = ["/run/ci-docker/docker.sock:/var/run/docker.sock", "/builds:/builds", "/cache:/cache"]
     shm_size = 1073741824
   ```

   `network_mode = "host"` puts jobs in the CI engine's network (services on
   `127.0.0.1`); the shared `/builds` lets services mount files of the checkout.

4. `docker compose up -d`.

### Who may run jobs

The CI engine runs privileged, so whoever can run a job on this runner can reach the host.
Keep it to this project's maintainers:

- **Sign-up off** on the GitLab instance (Admin → Settings → General → Sign-up
  restrictions), or register the runner as a **project** runner of this project only: an
  instance runner serves every project on the instance.
- The runner takes only jobs tagged `cenacle` (`run_untagged = false`; every job here has
  the tag through `default:`).
- Pipelines of merge requests from forks run in the fork, never in this project (Settings →
  CI/CD → "Run pipelines in the parent project" off), and a merge request merges only after
  its pipeline passed.
- `main`, `release-*` (the supported versions) and `v*` tags are protected: only maintainers
  push them, never by force, and only their pipelines see the signing keys.

### Protected pipelines and the shared engine

Every job can drive the CI engine (its socket is mounted) and write `/cache`, so a job of a
merge request's pipeline can change what later jobs run in: a locally tagged image, a
buildx builder, a cache. The pipeline keeps protected pipelines (`main`, `release-*`, `v*`
tags; `CI_COMMIT_REF_PROTECTED`) apart from the others as far as a pipeline can:

- Caches live in `/cache/protected-true` and `/cache/protected-false` (`CACHE_ROOT`), and
  GitLab's own caches carry the same prefix, so a protected pipeline never reads a module,
  build, browser, Electron, trivy or image-layer cache that a merge request wrote.
- buildx builders are per trust level (`cenacle-protected-true`, `cenacle-protected-false`);
  a release (`v*` tag) builds with a builder of its own, removed after the job, starts with
  no layer cache from any earlier pipeline, and runs BuildKit by digest (`BUILDKIT_IMAGE`).
- A release builds its CI image afresh from the tagged commit (`--pull --no-cache`, as
  `cenacle-ci:<n>-release`) and passes on the image's ID; the jobs that use the signing keys
  (`images` on tags, `desktop-sign`) stop unless they run in exactly that image
  (`ci/check-job-image.sh`).

None of this holds against a job that sets out to attack the engine: with the socket it can
reach every container and, the engine being privileged, the host. That boundary is the
runner's, so:

- **Recommended:** run protected pipelines on a runner of their own: a second runner with its
  own CI engine and `/cache`, registered with GitLab's **Protected** flag (it then takes only
  jobs of protected branches and tags) and its own tag, and keep this runner for the rest.
- Otherwise, let no one below Maintainer run pipelines in this project: only maintainers are
  members who can push branches or open merge requests here, and contributors' merge
  requests come from forks, whose pipelines run in the fork.
- Keep `COSIGN_KEY`, `COSIGN_PASSWORD`, `GHCR_TOKEN`, `GITHUB_RELEASE_TOKEN`, `GITHUB_MIRROR_TOKEN` and the GPG variables **protected**
  (and masked), so no other pipeline reads them.

## Housekeeping

Run daily on the CI host (it cleans the CI engine only, never the host's Docker):

```sh
docker exec cenacle-ci-docker-1 docker -H unix:///run/ci-docker/docker.sock container prune -f --filter until=24h
docker exec cenacle-ci-docker-1 docker -H unix:///run/ci-docker/docker.sock image prune -af --filter until=168h --filter 'label!=cenacle.ci.keep'
find /var/lib/cenacle-ci/cache/protected-*/buildx -mindepth 1 -maxdepth 1 -mtime +14 -exec rm -rf {} +
```

The caches of 0.99.1 and earlier (`/var/lib/cenacle-ci/cache/{go,golangci,ms-playwright,electron,electron-builder,makemsix,pnpm-store,trivy,buildx}`)
are no longer used and can be removed, as can the old shared builder
(`docker exec cenacle-ci-docker-1 docker -H unix:///run/ci-docker/docker.sock buildx rm cenacle`).

## Public publishing lock

Nothing goes to GitHub or ghcr.io while `ci/public-publishing` says `locked`; the pipeline
then publishes only to this GitLab project (its container and package registries). It stays
locked until the history has been rewritten and pushed to GitHub for 1.0, so that no commit
of the old history reaches a public repository. Every step that writes there asks
`ci/public-gate.sh` first:

| Job              | On                            | Writes, when open                                                                                        |
| ---------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| `images`         | `v*` tags                     | the images (and their signatures, SBOM attestations) to `PUBLIC_IMAGES`; the SBOMs to the GitHub release |
| `desktop`        | `v*` tags                     | the release files to the GitHub release (draft)                                                          |
| `desktop-sign`   | `v*` tags                     | `SHA256SUMS.sigstore.json` to the GitHub release (draft)                                                 |
| `github-release` | `v*` tags                     | publishes the GitHub release                                                                             |
| `mirror`         | the default branch, `v*` tags | the seven read-only repositories (below)                                                                 |

Pushes to the default branch write nothing else outside GitLab. While locked each of them
logs `public publishing is locked` and passes, with the tokens set or not; the lock is a
file in the repository, not a CI/CD variable, so no setting opens it on the old history.
It is opened by a reviewed commit that changes the word to `open`, made on the rewritten
history after it is on GitHub (`ci/mirror.test.sh` and `ci/github-release.test.mjs` test
both states; `make test-ci`).

## Mirror repositories

The job `mirror` (`ci/mirror.sh`) copies each folder in `ci/mirrors.txt` (`desktop/`,
`mobile/`, `deploy/compose`, `deploy/helm`, `sdk/go`, `sdk/python`, `docs/`) with its own
history (`git subtree split`) to its read-only repository next to the public one
(`cenacle-desktop`, `cenacle-mobile`, `cenacle-docker`, `cenacle-helm`, `cenacle-sdk-go`,
`cenacle-sdk-python`, `cenacle-docs`): the default branch to `main`, `v*` tags as tags. It
pushes only fast-forward, never with force, and needs the whole history (`GIT_DEPTH` 0).
The main repository stays the source: installing, issues, pull requests and the CLA check
are there, and the Go SDK's module path stays `github.com/Cenacle-TR/cenacle/sdk/go`.
`ci/mirror.sh --dry-run` shows what would be pushed.

It needs the protected, masked CI/CD variable `GITHUB_MIRROR_TOKEN`: a fine-grained GitHub
token for the seven repositories only, with "Contents: Read and write".

## Publishing images

A `v*` tag publishes `cenacle-{server,idp,web,proxy}` (amd64 and arm64) to the project's
container registry. With public publishing open (above), set the masked CI/CD variable
`GHCR_TOKEN` (a GitHub token with `write:packages`; `GHCR_USER` when the token is not the
account's own) to publish them for everyone as well, to `PUBLIC_IMAGES` in `.gitlab-ci.yml` (`ghcr.io/cenacle-tr`), which the
installation files use by default (`CENACLE_IMAGE_PREFIX` in `deploy/compose/prod.yml`,
`image.registry` in the Helm chart). The images' build provenance names `PUBLIC_SOURCE`
(the public repository) as their source, with the release's commit; the release job sets
the clone's remote to it before building.

The images are built once into an OCI archive and copied to each registry with skopeo,
which uploads every platform manifest itself. Pushing straight from buildkit failed on
GitLab's registry with `blob unknown to registry`: buildkit skips platform manifests
the registry reports as present, and the registry then rejected the index that
referenced them. A failure on one registry no longer stops the push to the other, nor
signing the image there. A version tag that already exists is never overwritten: the job
fails unless the registry already holds exactly this image (a re-run of the same
pipeline). The minor tag (`0.40`) moves with every release.

## Releasing

A release bumps the version in every one of these files, in one commit
(`chore: release X.Y.Z`), before the `vX.Y.Z` tag:

- `package.json`, `packages/core/package.json`, `packages/ui/package.json`,
  `web/package.json`, `idp/package.json`, `desktop/package.json`, `mobile/package.json`
- `deploy/helm/cenacle/Chart.yaml` (`version` and `appVersion`)
- `deploy/compose/.env.prod.example` (`CENACLE_VERSION`)
- `sdk/python/pyproject.toml` (`version`)
- `CHANGELOG.md` (the `[Unreleased]` section becomes the release) and, when operators must
  act, `docs/upgrade/README.md`

Then tag the release commit with `scripts/release-tag.sh vX.Y.Z`. It makes two annotated tags
on it: `vX.Y.Z` and `sdk/go/vX.Y.Z`. The Go SDK is a module of its own (`sdk/go`), and Go
finds a version of a module in a subdirectory only by a tag with the directory as prefix:
without it `go get github.com/Cenacle-TR/cenacle/sdk/go@vX.Y.Z` fails and `@latest` gets a
pseudo-version. Push both tags at once to each remote:
`git push --atomic <remote> vX.Y.Z sdk/go/vX.Y.Z`. The release pipeline fails at its first
stage (job `sdk-tag`) when `sdk/go/vX.Y.Z` is missing or on another commit. Tags starting with
`sdk/` start no pipeline.

## GitHub Releases

Each `v*` tag also publishes a release on the public repository's
[GitHub Releases](https://github.com/Cenacle-TR/cenacle/releases) (`PUBLIC_SOURCE`), with
`ci/github-release.mjs`: `images` uploads the SBOMs; `desktop` the installers and packages,
the update files with their signatures (`latest*.yml`, `.sig`, `.blockmap`), `index.json`,
the Group Policy templates, the server's `install.sh` with `cenacle-compose-<version>.tar.gz`
(docs/install/README.md), `SHA256SUMS` and `SHA256SUMS.asc`; `desktop-sign`
`SHA256SUMS.sigstore.json`. They upload to a draft, which nobody but the repository's
maintainers sees. The job `github-release` publishes it only when the checksums are signed,
the update files and SBOMs are there and every file `SHA256SUMS` lists is uploaded unchanged
(GitHub's SHA-256 of each file); a published release is never changed again.

It needs public publishing open (above) and the protected, masked CI/CD variable
`GITHUB_RELEASE_TOKEN`: a fine-grained GitHub token for the one repository with the
permission "Contents: Read and write". Without either the jobs say so and publish nothing on
GitHub; the package registry still gets every file.

## Signing releases

`ci/publish-image.sh` signs every published image with cosign and attaches a signed SPDX
SBOM (syft) to each platform's image; the SBOMs also go to the package registry as
`cenacle-sbom/<version>/` and to the release on GitHub Releases. The job `desktop-sign` signs the desktop app's `SHA256SUMS`:
the file the `desktop` job made, passed on as a job artifact with its digest, never one
fetched by name from the package registry (anyone who can write packages can replace
those); it refuses to sign when the registry serves a different file.
They need the protected CI/CD variables `COSIGN_KEY` (a file) and `COSIGN_PASSWORD`, and
`v*` tags protected so their pipelines can read them. Set all of it up once with:

```sh
GITLAB_URL=https://<your GitLab> GITLAB_PROJECT=<group>/<project> \
GITLAB_TOKEN=<a token with the api scope> ci/setup-signing.sh
```

and commit the `deploy/cosign.pub` it writes. Signing uses no transparency log
(`ci/signing-config.json` names no services), so verification works offline with the
public key alone (`docs/security/README.md`). Without the variables, releases are
published unsigned.

### Desktop update key

The desktop app installs an update only when its update file (`latest.yml`,
`latest-linux.yml`, `latest-linux-arm64.yml`) is signed with a release key built into the
app (`desktop/src/update-keys.ts`, Ed25519): the server the app is paired with only hosts
the files. The `desktop` job signs them with `desktop/scripts/sign-updates.mjs`, which
writes `<file>.sig` next to each and refuses a key that is not built into the app. It needs
the protected CI/CD variable `DESKTOP_UPDATE_KEY` (type **file**: the PEM private key).
Without it the release has no `.sig` files, and installed apps do not take it as an update.

To make a new key (for example when an organization builds the app itself):

```sh
openssl genpkey -algorithm ed25519 -out desktop-update-key.pem
openssl pkey -in desktop-update-key.pem -pubout
```

Put the public key in `desktop/src/update-keys.ts` and the private key in
`DESKTOP_UPDATE_KEY`. Keep one encrypted backup of the private key offline and no other copy.
To replace a key, ship a release that has both the old and the new public key, sign the next
ones with the new key, and drop the old key a release later. Losing the key means installed
apps have to be updated by hand once.

To check that a backup belongs to the key built into the app, compare SHA-256 fingerprints
of the public key (DER form). The first command reads the app's key, the second the backup
(it asks for the backup's passphrase):

```sh
sed -n '/BEGIN PUBLIC KEY/,/END PUBLIC KEY/p' desktop/src/update-keys.ts | sed 's/^ *`//; s/`,$//' \
  | openssl pkey -pubin -outform DER | openssl dgst -sha256
openssl pkey -in desktop-update-key.pem -pubout -outform DER | openssl dgst -sha256
```

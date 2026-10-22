# Continuous integration

The pipeline is `.gitlab-ci.yml` (ADR 0022): lint, tests (Go, Node.js 24 and 26,
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
    command: ['dockerd', '--host=unix:///run/ci-docker/docker.sock']
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

## Housekeeping

Run daily on the CI host (it cleans the CI engine only, never the host's Docker):

```sh
docker exec cenacle-ci-docker-1 docker -H unix:///run/ci-docker/docker.sock container prune -f --filter until=24h
docker exec cenacle-ci-docker-1 docker -H unix:///run/ci-docker/docker.sock image prune -af --filter until=168h --filter 'label!=cenacle.ci.keep'
find /var/lib/cenacle-ci/cache/buildx -mindepth 1 -maxdepth 1 -mtime +14 -exec rm -rf {} +
```

## Publishing images

A `v*` tag publishes `cenacle-{server,idp,web,proxy}` (amd64 and arm64) to the project's
container registry. Set the masked CI/CD variable `GHCR_TOKEN` (a GitHub token with
`write:packages`, and `GHCR_USER` if not the default) to publish them to GitHub's
registry as well, which `deploy/compose/prod.yml` uses by default.

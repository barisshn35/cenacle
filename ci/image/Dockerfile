# SPDX-License-Identifier: Apache-2.0
#
# The image CI jobs run in: Go, Node.js 24 and 26 with pnpm, the Docker CLI
# (jobs start their test services next to them) and the system libraries
# Playwright's Chromium needs. The browser itself is downloaded into the CI
# cache by the jobs. Bump CI_IMAGE in .gitlab-ci.yml when this file changes.
FROM docker:29.9.2-cli AS docker

FROM golang:1.26.10-trixie

ARG NODE24=24.22.1
ARG NODE24_SHA256=6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6
ARG NODE26=26.12.1
ARG NODE26_SHA256=6170b2d474e1c626f43cff3adc118df9fe3b573258a4fc3d850c8dbc6b079bbd
ARG PNPM=12.14.0
ARG PLAYWRIGHT=1.64.1

LABEL cenacle.ci.keep="true"

COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git jq make xz-utils \
 && rm -rf /var/lib/apt/lists/*

# Node.js 24 (default) and 26 (PATH=/opt/node26/bin:$PATH), checked against the release checksums.
RUN set -eu; \
    for v in "24 $NODE24 $NODE24_SHA256" "26 $NODE26 $NODE26_SHA256"; do \
      set -- $v; \
      curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v$2/node-v$2-linux-x64.tar.xz"; \
      echo "$3  /tmp/node.tar.xz" | sha256sum -c -; \
      mkdir -p "/opt/node$1"; \
      tar -xJf /tmp/node.tar.xz -C "/opt/node$1" --strip-components=1; \
      rm /tmp/node.tar.xz; \
    done
ENV PATH=/opt/node24/bin:$PATH

# pnpm runs on whichever Node.js is first on PATH.
RUN npm install -g --prefix /usr/local "pnpm@$PNPM" \
 && npx -y "playwright@$PLAYWRIGHT" install-deps chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm

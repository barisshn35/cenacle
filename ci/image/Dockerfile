# SPDX-License-Identifier: AGPL-3.0-only
#
# The image CI jobs run in: Go, Node.js 26 with pnpm, the Docker CLI
# (jobs start their test services next to them), the system libraries
# Playwright's Chromium needs, and GTK, a keyring library and Xvfb for the
# desktop app's tests (Electron under a virtual display). The browser itself
# is downloaded into the CI cache by the jobs. Bump CI_IMAGE in .gitlab-ci.yml
# when this file changes.
FROM docker:29.9.2-cli@sha256:5e6baf67325a79f64ed3bed6863954d5e05d0f3d4e57cbdb14809346814bbfdb AS docker

FROM golang:1.26.10-trixie@sha256:909771fef53e3dcb0950255f0c9a8b4728c3b841e61509c7b29b098de7ee02d4

ARG NODE=26.13.0
ARG NODE_SHA256=d28a96af6c38596f6d9d97c0ee531c13d238d757742387d1928de822d959e997
ARG PNPM=12.14.0
ARG PLAYWRIGHT=1.64.1

LABEL cenacle.ci.keep="true"

COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git jq make xz-utils \
 && rm -rf /var/lib/apt/lists/*

# Node.js 26 LTS (.nvmrc), checked against the release checksum.
RUN set -eu; \
    curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v$NODE/node-v$NODE-linux-x64.tar.xz"; \
    echo "$NODE_SHA256  /tmp/node.tar.xz" | sha256sum -c -; \
    mkdir -p /opt/node; \
    tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1; \
    rm /tmp/node.tar.xz
ENV PATH=/opt/node/bin:$PATH

# pnpm runs on whichever Node.js is first on PATH.
RUN npm install -g --prefix /usr/local "pnpm@$PNPM" \
 && npx -y "playwright@$PLAYWRIGHT" install-deps chromium \
 && apt-get update \
 && apt-get install -y --no-install-recommends xvfb xauth libgtk-3-0t64 libnotify4 libsecret-1-0 libxss1 \
 && rm -rf /var/lib/apt/lists/* /root/.npm

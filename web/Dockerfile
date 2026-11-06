# SPDX-License-Identifier: AGPL-3.0-only
# Cenacle web app: static build served by Caddy. Build from the repository root:
#   docker build -f web/Dockerfile -t cenacle-web .

# Caddy built from source with our patched Go toolchain (see deploy/caddy).
FROM --platform=$BUILDPLATFORM golang:1.26.10-alpine3.24@sha256:27f2d3b83cfc5803c8078f8e730af0f7c431bf067afaec8f60a36fb763187cba AS caddy
WORKDIR /src
COPY deploy/caddy/go.mod deploy/caddy/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY deploy/caddy/main.go ./
COPY scripts/go-notices.sh /usr/local/bin/go-notices
ARG TARGETOS TARGETARCH
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags "-s -w" -o /out/caddy . \
 && CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go-notices . "Caddy, the web server of the Cenacle web image" > /out/THIRD_PARTY_NOTICES-caddy.txt

FROM --platform=$BUILDPLATFORM node:26.13.0-alpine3.24@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS build
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
# pnpm, the version package.json's packageManager names, from the npm registry
# (Node.js ships no Corepack since 25); a slow registry should not fail the
# build: try a few times.
RUN for i in 1 2 3 4; do npm install -g "$(node -p 'require("./package.json").packageManager')" && pnpm --version && exit 0; echo "pnpm install failed ($i), retrying"; sleep $((i * 10)); done; exit 1
COPY web/package.json web/
COPY packages/ui/package.json packages/ui/
COPY packages/core/package.json packages/core/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @cenacle/web...
COPY packages/ packages/
COPY scripts/third-party-notices.* scripts/
COPY web/ web/
RUN pnpm --filter @cenacle/web exec vite build

FROM alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6
RUN apk add --no-cache ca-certificates mailcap \
 && addgroup -g 10001 cenacle && adduser -D -H -u 10001 -G cenacle cenacle \
 && mkdir -p /data /config /etc/caddy \
 && chown cenacle:cenacle /data /config \
 && rm -f /var/log/apk.log
COPY --from=caddy /out/caddy /usr/bin/caddy
# Cenacle's license and those of Caddy; the web app's are in /srv/third-party-notices.txt.
COPY LICENSE /licenses/LICENSE
COPY --from=caddy /out/THIRD_PARTY_NOTICES-caddy.txt /licenses/THIRD_PARTY_NOTICES-caddy.txt
ENV XDG_DATA_HOME=/data \
    XDG_CONFIG_HOME=/config
COPY web/deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/web/dist /srv
# Numeric, so Kubernetes can check runAsNonRoot.
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD ["wget", "-qO-", "http://127.0.0.1:8080/healthz"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]

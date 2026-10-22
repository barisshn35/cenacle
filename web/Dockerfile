# SPDX-License-Identifier: Apache-2.0
# Cenacle web app: static build served by Caddy. Build from the repository root:
#   docker build -f web/Dockerfile -t cenacle-web .

# Caddy built from source with our patched Go toolchain (see deploy/caddy).
FROM --platform=$BUILDPLATFORM golang:1.26.10-alpine3.24 AS caddy
WORKDIR /src
COPY deploy/caddy/go.mod deploy/caddy/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY deploy/caddy/main.go ./
ARG TARGETOS TARGETARCH
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags "-s -w" -o /out/caddy .

FROM --platform=$BUILDPLATFORM node:24.22.0-alpine3.24 AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
# Corepack fetches pnpm (the version in package.json) from the npm registry; a
# slow registry should not fail the build: try a few times.
RUN for i in 1 2 3 4; do pnpm --version && exit 0; echo "pnpm download failed ($i), retrying"; sleep $((i * 10)); done; exit 1
COPY web/package.json web/
COPY packages/ui/package.json packages/ui/
COPY packages/core/package.json packages/core/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @cenacle/web...
COPY packages/ packages/
COPY web/ web/
RUN pnpm --filter @cenacle/web exec vite build

FROM alpine:3.24.2
RUN apk add --no-cache ca-certificates mailcap \
 && adduser -D -H -u 10001 cenacle \
 && mkdir -p /data /config /etc/caddy \
 && chown cenacle:cenacle /data /config
COPY --from=caddy /out/caddy /usr/bin/caddy
ENV XDG_DATA_HOME=/data \
    XDG_CONFIG_HOME=/config
COPY web/deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/web/dist /srv
USER cenacle
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD ["wget", "-qO-", "http://127.0.0.1:8080/healthz"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]

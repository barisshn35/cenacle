# SPDX-License-Identifier: AGPL-3.0-only
# Reverse proxy with automatic TLS, running as an unprivileged user.
# Build context is the repository root (see prod.yml). Ports 80/443 are opened
# via the net.ipv4.ip_unprivileged_port_start sysctl, so no capabilities are needed.

# Caddy built from source with our patched Go toolchain (see deploy/caddy).
FROM --platform=$BUILDPLATFORM golang:1.26.10-alpine3.24@sha256:27f2d3b83cfc5803c8078f8e730af0f7c431bf067afaec8f60a36fb763187cba AS caddy
WORKDIR /src
COPY deploy/caddy/go.mod deploy/caddy/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY deploy/caddy/main.go ./
# FIPS=true: TLS with the Go Cryptographic Module in FIPS 140-3 mode.
ARG TARGETOS TARGETARCH FIPS=false
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    GOFIPS140="$([ "$FIPS" = true ] && echo v1.0.0 || echo off)" \
    go build -trimpath -ldflags "-s -w" -o /out/caddy .

FROM alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6
RUN apk add --no-cache ca-certificates mailcap \
 && addgroup -g 10001 cenacle && adduser -D -H -u 10001 -G cenacle cenacle \
 && mkdir -p /data /config /etc/caddy \
 && chown cenacle:cenacle /data /config \
 && rm -f /var/log/apk.log
COPY --from=caddy /out/caddy /usr/bin/caddy
ENV XDG_DATA_HOME=/data \
    XDG_CONFIG_HOME=/config
COPY deploy/compose/caddy/Caddyfile /etc/caddy/Caddyfile
# Numeric, so Kubernetes can check runAsNonRoot.
USER 10001:10001
EXPOSE 80 443 443/udp
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]

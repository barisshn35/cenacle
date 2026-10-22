# SPDX-License-Identifier: AGPL-3.0-only
# Reverse proxy with automatic TLS, running as an unprivileged user.
# Build context is the repository root (see prod.yml). Ports 80/443 are opened
# via the net.ipv4.ip_unprivileged_port_start sysctl, so no capabilities are needed.

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

FROM alpine:3.24.2
RUN apk add --no-cache ca-certificates mailcap \
 && adduser -D -H -u 10001 cenacle \
 && mkdir -p /data /config /etc/caddy \
 && chown cenacle:cenacle /data /config
COPY --from=caddy /out/caddy /usr/bin/caddy
ENV XDG_DATA_HOME=/data \
    XDG_CONFIG_HOME=/config
COPY deploy/compose/caddy/Caddyfile /etc/caddy/Caddyfile
USER cenacle
EXPOSE 80 443 443/udp
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]

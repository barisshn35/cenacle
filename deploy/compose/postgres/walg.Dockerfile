# SPDX-License-Identifier: AGPL-3.0-only
# PostgreSQL (the same Alpine image as the stack, with pgvector) with WAL-G (Apache-2.0) for
# continuous archiving. WAL-G is built from source as a static binary.
FROM --platform=$BUILDPLATFORM golang:1.26.10-alpine3.24@sha256:27f2d3b83cfc5803c8078f8e730af0f7c431bf067afaec8f60a36fb763187cba AS walg
ARG WALG_VERSION=v3.0.9
RUN apk add --no-cache git
RUN git clone --depth 1 --branch "$WALG_VERSION" https://github.com/wal-g/wal-g /src
WORKDIR /src
# Dependencies with known fixes since the release (trivy, 2026-11-06). Trivy's
# CVE-2021-38599 on wal-g itself matches only its pseudo-version (fixed in 1.1).
RUN --mount=type=cache,target=/root/go/pkg/mod \
    go get github.com/go-jose/go-jose/v4@v4.1.6 golang.org/x/net@v0.60.0 google.golang.org/grpc@v1.83.2 \
 && go mod tidy
ARG TARGETOS TARGETARCH
RUN --mount=type=cache,target=/root/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    GOEXPERIMENT=jsonv2 CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags "-s -w -X github.com/wal-g/wal-g/cmd/pg.walgVersion=$WALG_VERSION" \
    -o /out/wal-g ./main/pg

# pgvector, as in deploy/compose/postgres/Dockerfile (keep the two the same).
FROM postgres:18.6-alpine3.24@sha256:10a5c69a83035ab5239f5620d708520e8b28f5aa1f2b20143e6024532edadfb5 AS pgvector
ARG PGVECTOR_VERSION=0.8.7
ARG PGVECTOR_SHA256=cac0b10c360f05b2d521200105ba3697e773d4cd3731f5a915a7e37ebe0bea85
RUN apk add --no-cache --virtual .build build-base curl
RUN curl -fsSL -o /tmp/pgvector.tar.gz "https://github.com/pgvector/pgvector/archive/refs/tags/v${PGVECTOR_VERSION}.tar.gz" \
 && echo "${PGVECTOR_SHA256}  /tmp/pgvector.tar.gz" | sha256sum -c - \
 && mkdir /src && tar -xzf /tmp/pgvector.tar.gz -C /src --strip-components=1
WORKDIR /src
RUN make OPTFLAGS='' with_llvm=no && make install with_llvm=no DESTDIR=/out

FROM postgres:18.6-alpine3.24@sha256:10a5c69a83035ab5239f5620d708520e8b28f5aa1f2b20143e6024532edadfb5
# Upgrading takes the fixes released after the base image (e.g. zlib, 2026-11-06).
# gosu only steps down from root, and this image runs as postgres already.
RUN apk upgrade --no-cache && rm -f /var/log/apk.log /usr/local/bin/gosu
COPY --from=walg /out/wal-g /usr/local/bin/wal-g
COPY --from=pgvector /out/usr/local/lib/postgresql/ /usr/local/lib/postgresql/
COPY --from=pgvector /out/usr/local/share/postgresql/extension/ /usr/local/share/postgresql/extension/
COPY deploy/compose/postgres/walg-backup.sh /usr/local/bin/walg-backup
# The image's postgres user (uid 70) owns the data directory; no root needed.
USER postgres

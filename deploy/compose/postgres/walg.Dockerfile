# SPDX-License-Identifier: AGPL-3.0-only
# PostgreSQL (the same Alpine image as the stack) with WAL-G (Apache-2.0) for
# continuous archiving. WAL-G is built from source as a static binary.
FROM --platform=$BUILDPLATFORM golang:1.26.10-alpine3.24 AS walg
ARG WALG_VERSION=v3.0.9
RUN apk add --no-cache git
RUN git clone --depth 1 --branch "$WALG_VERSION" https://github.com/wal-g/wal-g /src
WORKDIR /src
ARG TARGETOS TARGETARCH
RUN --mount=type=cache,target=/root/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    GOEXPERIMENT=jsonv2 CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags "-s -w -X github.com/wal-g/wal-g/cmd/pg.walgVersion=$WALG_VERSION" \
    -o /out/wal-g ./main/pg

FROM postgres:18.6-alpine3.24
COPY --from=walg /out/wal-g /usr/local/bin/wal-g
COPY deploy/compose/postgres/walg-backup.sh /usr/local/bin/walg-backup
# The image's postgres user (uid 70) owns the data directory; no root needed.
USER postgres

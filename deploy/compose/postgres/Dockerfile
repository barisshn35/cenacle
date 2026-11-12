# SPDX-License-Identifier: AGPL-3.0-only
# PostgreSQL (the official Alpine image) with pgvector (PostgreSQL License) for
# semantic search (ADR 0055). pgvector is built from its pinned source; the
# image stays Alpine so an existing data directory keeps its collations.
FROM postgres:18.6-alpine3.24@sha256:10a5c69a83035ab5239f5620d708520e8b28f5aa1f2b20143e6024532edadfb5 AS pgvector
ARG PGVECTOR_VERSION=0.8.7
ARG PGVECTOR_SHA256=cac0b10c360f05b2d521200105ba3697e773d4cd3731f5a915a7e37ebe0bea85
RUN apk add --no-cache --virtual .build build-base curl
RUN curl -fsSL -o /tmp/pgvector.tar.gz "https://github.com/pgvector/pgvector/archive/refs/tags/v${PGVECTOR_VERSION}.tar.gz" \
 && echo "${PGVECTOR_SHA256}  /tmp/pgvector.tar.gz" | sha256sum -c - \
 && mkdir /src && tar -xzf /tmp/pgvector.tar.gz -C /src --strip-components=1
WORKDIR /src
# OPTFLAGS='' builds for any CPU of the architecture (not only the builder's).
RUN make OPTFLAGS='' with_llvm=no && make install with_llvm=no DESTDIR=/out

FROM postgres:18.6-alpine3.24@sha256:10a5c69a83035ab5239f5620d708520e8b28f5aa1f2b20143e6024532edadfb5
# Upgrading takes the fixes released after the base image.
# gosu only steps down from root, and this image runs as postgres already.
RUN apk upgrade --no-cache && rm -f /var/log/apk.log /usr/local/bin/gosu
COPY --from=pgvector /out/usr/local/lib/postgresql/ /usr/local/lib/postgresql/
COPY --from=pgvector /out/usr/local/share/postgresql/extension/ /usr/local/share/postgresql/extension/
# The image's postgres user (uid 70) owns the data directory; no root needed.
USER postgres

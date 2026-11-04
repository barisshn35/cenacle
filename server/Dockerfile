# SPDX-License-Identifier: AGPL-3.0-only
# Cenacle chat server. Build from the repository root:
#   docker build -f server/Dockerfile -t cenacle-server .
# FIPS 140-3 (the Go Cryptographic Module v1.0.0, CMVP #5247):
#   docker build -f server/Dockerfile --build-arg FIPS=true -t cenacle-server-fips .

# Cross-compile on the build host's native platform (fast multi-arch builds).
FROM --platform=$BUILDPLATFORM golang:1.26.10-alpine3.24@sha256:a2012b4a1d1f9f7e9f44e0d39b805a901e856b1dd80b4e6ee4338db547050308 AS build
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY server/ ./
COPY scripts/go-notices.sh /usr/local/bin/go-notices
ARG TARGETOS TARGETARCH VERSION=dev FIPS=false
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    GOFIPS140="$([ "$FIPS" = true ] && echo v1.0.0 || echo off)" \
    go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/cenacle-server ./cmd/server \
 && mkdir -p /out/files \
 && CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go-notices ./cmd/server "the Cenacle server" > /out/THIRD_PARTY_NOTICES.txt

# Static binary on distroless: no shell, no package manager, non-root (65532).
FROM gcr.io/distroless/static-debian13:nonroot@sha256:18f4cc26c9ffa7f20a359298be7deadac5c607c8e03a02b8119f1a5fc2f82c99
COPY --from=build /out/cenacle-server /usr/local/bin/cenacle-server
# Cenacle's license and those of the code built into the server.
COPY LICENSE /licenses/LICENSE
COPY --from=build /out/THIRD_PARTY_NOTICES.txt /licenses/THIRD_PARTY_NOTICES.txt
# The directory of the "dir" files backend: a new volume mounted here starts
# out owned by the server's user.
COPY --from=build --chown=65532:65532 /out/files /data/files
ENV CENACLE_ENV=production \
    CENACLE_HTTP_ADDR=:8180
EXPOSE 8180
# Numeric, so Kubernetes can check runAsNonRoot (the distroless "nonroot" user).
USER 65532:65532
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD ["/usr/local/bin/cenacle-server", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/cenacle-server"]
CMD ["serve"]

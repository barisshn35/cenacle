# SPDX-License-Identifier: AGPL-3.0-only
# Cenacle chat server. Build from the repository root:
#   docker build -f server/Dockerfile -t cenacle-server .
# FIPS 140-3 (the Go Cryptographic Module v1.0.0, CMVP #5247):
#   docker build -f server/Dockerfile --build-arg FIPS=true -t cenacle-server-fips .

# Cross-compile on the build host's native platform (fast multi-arch builds).
FROM --platform=$BUILDPLATFORM golang:1.26.10-alpine3.24 AS build
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY server/ ./
ARG TARGETOS TARGETARCH VERSION=dev FIPS=false
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    GOFIPS140="$([ "$FIPS" = true ] && echo v1.0.0 || echo off)" \
    go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/cenacle-server ./cmd/server \
 && mkdir -p /out/files

# Static binary on distroless: no shell, no package manager, non-root (65532).
FROM gcr.io/distroless/static-debian13:nonroot
COPY --from=build /out/cenacle-server /usr/local/bin/cenacle-server
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

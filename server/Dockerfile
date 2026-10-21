# SPDX-License-Identifier: Apache-2.0
# Cenacle chat server. Build from the repository root:
#   docker build -f server/Dockerfile -t cenacle-server .

# Cross-compile on the build host's native platform (fast multi-arch builds).
FROM --platform=$BUILDPLATFORM golang:1.27.2-alpine3.24 AS build
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY server/ ./
ARG TARGETOS TARGETARCH VERSION=dev
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/cenacle-server ./cmd/server

# Static binary on distroless: no shell, no package manager, non-root (65532).
FROM gcr.io/distroless/static-debian13:nonroot
COPY --from=build /out/cenacle-server /usr/local/bin/cenacle-server
ENV CENACLE_ENV=production \
    CENACLE_HTTP_ADDR=:8180
EXPOSE 8180
USER nonroot:nonroot
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD ["/usr/local/bin/cenacle-server", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/cenacle-server"]
CMD ["serve"]

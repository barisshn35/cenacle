# SPDX-License-Identifier: AGPL-3.0-only
# Build from repository root, after operator make gen. No media is persisted.
FROM --platform=$BUILDPLATFORM golang:1.26.10-alpine3.24@sha256:27f2d3b83cfc5803c8078f8e730af0f7c431bf067afaec8f60a36fb763187cba AS build
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY server/ ./
COPY scripts/go-notices.sh /usr/local/bin/go-notices
ARG TARGETOS TARGETARCH VERSION=dev
# Capacity measurements only: TAGS=medialab (docs/operations/performance.md). Releases leave it empty.
ARG TAGS=
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -tags "${TAGS}" -ldflags "-s -w -X main.version=${VERSION}" -o /out/cenacle-media ./cmd/media/main.go \
 && CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go-notices ./cmd/media "Cenacle media" > /out/THIRD_PARTY_NOTICES.txt
FROM gcr.io/distroless/static-debian13:nonroot@sha256:25ac8f0c3b2334a9eb05452266bd4697864a8c8ef0ef71e5e6480d7f92868329
COPY --from=build /out/cenacle-media /usr/local/bin/cenacle-media
COPY LICENSE /licenses/LICENSE
COPY --from=build /out/THIRD_PARTY_NOTICES.txt /licenses/THIRD_PARTY_NOTICES.txt
ENV CENACLE_MEDIA_HTTP_ADDR=:7880
USER 65532:65532
EXPOSE 7880/tcp 7881/tcp 7882/udp
HEALTHCHECK --interval=10s --timeout=4s --retries=3 CMD ["/usr/local/bin/cenacle-media", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/cenacle-media"]
CMD ["serve"]

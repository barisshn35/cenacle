#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
#
# Loads the images of an offline bundle (see bundle.sh) into the local Docker
# engine after checking the bundle's checksums, and names them as the compose
# files do, so `docker compose up` finds every image without a registry.
set -eu
cd "$(dirname "$0")"
sha256sum -c SHA256SUMS
# Only the containerd image store keeps the pinned digests of the images it
# loads; the classic store cannot find `name:tag@sha256:...` without a registry.
store=$(docker info --format '{{json .DriverStatus}}')
if ! echo "$store" | grep -q io.containerd.snapshotter; then
  echo "Docker's containerd image store is needed for digest-pinned images; see" >&2
  echo "\"Offline (air-gapped) installs\" in docs/operations/README.md" >&2
  exit 1
fi
gunzip -c images.tar.gz | docker load
# `docker load` gives digest-pinned images no name. Their image ID is the
# pinned digest: tagging it as name:tag makes `name:tag@sha256:...` resolve.
missing=""
while read -r ref; do
  case "$ref" in
    *@sha256:*) docker tag "${ref#*@}" "${ref%@*}" || true ;;
  esac
  docker image inspect "$ref" > /dev/null 2>&1 || missing="$missing $ref"
done < images.txt
if [ -n "$missing" ]; then
  echo "not found after loading:$missing" >&2
  exit 1
fi
echo "loaded:"
cat images.txt
if [ -d secrets ]; then
  echo "empty secret files are in $(pwd)/secrets: copy them to deploy/compose/secrets"
  echo "(cp -rn) and fill them in, or run gen-secrets.sh there (docs/operations)"
fi

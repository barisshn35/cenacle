#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
#
# Starts the development Garage on 127.0.0.1:13900 for CI (no compose there)
# and waits until its bucket exists.
set -eu
cd "$(dirname "$0")"
docker run -d --name cenacle-ci-garage -p 127.0.0.1:13900:3900 \
  -v "$PWD/dev.toml:/etc/garage.toml:ro" \
  -e GARAGE_DEFAULT_ACCESS_KEY=GK0000000000000000000000c1 \
  -e GARAGE_DEFAULT_SECRET_KEY=000000000000000000000000000000000000000000000000000000000000dec1 \
  -e GARAGE_DEFAULT_BUCKET=cenacle-files \
  "${GARAGE_IMAGE:-dxflrs/garage:v2.4.1@sha256:9c96caa2612d3411acc5b0e6701fb238dbfba33e533a6d7d3d811a4b12d0d020}" /garage server --single-node --default-bucket >/dev/null
for _ in $(seq 60); do
  if docker exec cenacle-ci-garage /garage bucket info cenacle-files >/dev/null 2>&1; then
    echo "garage ready"
    exit 0
  fi
  sleep 1
done
docker logs cenacle-ci-garage
exit 1

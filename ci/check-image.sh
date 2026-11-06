#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Checks a built image: no setuid or setgid files, it starts with a read-only
# root file system and no capabilities, and FIPS images run in FIPS mode.
#   ci/check-image.sh <image> <name>
set -eu
image=$1
name=$2

container=$(docker create "$image")
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
# tar -tv prints the mode first: s or S in the user or group execute place.
found=$(docker export "$container" | tar -tvf - | awk '$1 ~ /^-..[sS]/ || $1 ~ /^-.....[sS]/ {print $NF}')
if [ -n "$found" ]; then
  echo "setuid/setgid files in $image:"
  echo "$found"
  exit 1
fi

# The binary runs as configured for production (STIG profile: read-only root,
# all capabilities dropped, no privilege escalation).
hardened="--rm --read-only --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp"
case "$name" in
  server | server-fips | media)
    out=$(docker run $hardened "$image" version)
    echo "version: $out"
    case "$name:$out" in
      server-fips:*"FIPS 140-3 mode"*) ;;
      server-fips:*) echo "the FIPS image does not run in FIPS 140-3 mode"; exit 1 ;;
    esac
    ;;
  idp | idp-fips)
    fips=$(docker run $hardened --entrypoint node "$image" \
      $( [ "$name" = idp-fips ] && echo --enable-fips ) -p 'require("node:crypto").getFips()')
    echo "fips: $fips"
    if [ "$name" = idp-fips ] && [ "$fips" != 1 ]; then
      echo "the FIPS image does not run in FIPS mode"
      exit 1
    fi
    ;;
  proxy | proxy-fips | web)
    info=$(docker run $hardened --entrypoint caddy "$image" build-info)
    echo "$info" | head -1
    if [ "$name" = proxy-fips ] && ! echo "$info" | grep -q 'GOFIPS140=v1.0.0'; then
      echo "the FIPS proxy is not built with the Go Cryptographic Module v1.0.0"
      exit 1
    fi
    ;;
esac
echo "$image: checks passed"

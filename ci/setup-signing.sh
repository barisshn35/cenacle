#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
#
# Sets up release signing for a GitLab project, once: makes a new cosign key
# pair, keeps the private key and its password only in the project's CI/CD
# variables (COSIGN_KEY, COSIGN_PASSWORD; protected), protects v* tags (so
# only their pipelines read those variables) and writes the public key to
# deploy/cosign.pub, to be committed. Nothing secret is printed or kept on
# disk. Running it again replaces the key: releases signed before stay
# verifiable with the old public key only.
#
#   GITLAB_URL=https://git.example.com GITLAB_PROJECT=group/cenacle \
#   GITLAB_TOKEN=<token with the api scope> ci/setup-signing.sh
set -eu
: "${GITLAB_URL:?}" "${GITLAB_PROJECT:?}" "${GITLAB_TOKEN:?}"
COSIGN_IMAGE=${COSIGN_IMAGE:-ghcr.io/sigstore/cosign/cosign:v3.1.4@sha256:0f06154836d2de34f887a5c273506d52ca43edaa1d9e53e6510fa78a48f69c2d}
root=$(cd "$(dirname "$0")/.." && pwd)
project=$(printf '%s' "$GITLAB_PROJECT" | sed 's#/#%2F#g')
api="$GITLAB_URL/api/v4/projects/$project"

# In memory where possible, and removed whatever happens.
work=$(mktemp -d "${TMPDIR:-/dev/shm}/cosign.XXXXXX" 2>/dev/null || mktemp -d)
chmod 700 "$work"
trap 'rm -rf "$work"' EXIT INT TERM

password=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
docker run --rm --user "$(id -u)" --network none -v "$work:/w" -w /w -e COSIGN_PASSWORD="$password" \
  "$COSIGN_IMAGE" generate-key-pair >/dev/null

# A variable is created, or replaced when it exists.
put() {
  key=$1
  shift
  curl --fail --silent --show-error -o /dev/null -X DELETE -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
    "$api/variables/$key" 2>/dev/null || true
  curl --fail --silent --show-error -o /dev/null -X POST -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
    "$api/variables" --form "key=$key" --form "protected=true" "$@"
}
put COSIGN_KEY --form "variable_type=file" --form "value=<$work/cosign.key"
put COSIGN_PASSWORD --form "masked=true" --form "value=$password"
curl --silent --show-error -o /dev/null -X POST -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "$api/protected_tags?name=v*&create_access_level=40" || true

cp "$work/cosign.pub" "$root/deploy/cosign.pub"
echo "Release signing is set up. Commit deploy/cosign.pub:"
cat "$root/deploy/cosign.pub"

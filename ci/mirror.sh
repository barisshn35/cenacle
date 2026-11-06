#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
#
# Copies each folder in ci/mirrors.txt, with its own history (git subtree
# split), to its read-only repository next to the public one: the commit's
# branch to main, a v* tag as the same tag. Pushes only fast-forward, never
# with force. Stops before anything else while public publishing is locked
# (ci/public-gate.sh).
#
# Needs the whole history (GIT_DEPTH 0) and GITHUB_MIRROR_TOKEN (a token that
# may write the seven repositories' contents). MIRROR_BASE replaces
# https://github.com/<account of PUBLIC_SOURCE> (tests).
#
# Usage: ci/mirror.sh [--dry-run]
#   --dry-run  split and print what would be pushed; push nothing
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
dry=false
[ "${1:-}" = --dry-run ] && dry=true

if ! "$here/public-gate.sh"; then
  echo "mirror: nothing pushed"
  exit 0
fi

rev="${CI_COMMIT_SHA:-$(git rev-parse HEAD)}"
if [ -n "${CI_COMMIT_TAG:-}" ]; then
  case "$CI_COMMIT_TAG" in v*) ;; *) echo "mirror: $CI_COMMIT_TAG is not a release tag"; exit 1 ;; esac
  ref="refs/tags/$CI_COMMIT_TAG"
else
  ref="refs/heads/main"
fi
if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
  echo "mirror: the clone is shallow; the job needs GIT_DEPTH 0"
  exit 1
fi

if [ -z "${MIRROR_BASE:-}" ]; then
  account="$(printf '%s' "${PUBLIC_SOURCE:-}" | sed -n 's,^https://github\.com/\([^/]*\)/.*,\1,p')"
  [ -n "$account" ] || { echo "mirror: PUBLIC_SOURCE does not name a GitHub repository"; exit 1; }
  MIRROR_BASE="https://github.com/$account"
fi
if ! $dry && [ -z "${GITHUB_MIRROR_TOKEN:-}" ]; then
  echo "mirror: GITHUB_MIRROR_TOKEN is not set: nothing pushed"
  exit 1
fi
if [ -n "${GITHUB_MIRROR_TOKEN:-}" ]; then
  # The token as an HTTP header for github.com only, from the environment
  # (not in the command line or a URL that git could print).
  GIT_CONFIG_COUNT=1
  GIT_CONFIG_KEY_0="http.https://github.com/.extraheader"
  GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GITHUB_MIRROR_TOKEN" | base64 | tr -d '\n')"
  export GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0
fi

status=0
grep -v -e '^#' -e '^[[:space:]]*$' "$here/mirrors.txt" | while read -r folder repo; do
  split="$(git subtree split --quiet --prefix="$folder" "$rev")"
  if $dry; then
    echo "mirror: would push $folder ($split) to $MIRROR_BASE/$repo.git $ref"
    continue
  fi
  echo "mirror: $folder ($split) to $repo $ref"
  git push --quiet "$MIRROR_BASE/$repo.git" "$split:$ref" || exit 1
done || status=1
exit $status

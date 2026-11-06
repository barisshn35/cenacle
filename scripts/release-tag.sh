#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
#
# Tags a release: vX.Y.Z and sdk/go/vX.Y.Z (the Go SDK is a module of its own
# in sdk/go, and Go finds a version of it only by a tag with that prefix), both
# annotated, on the release commit (HEAD by default). Then
# push both at once to each remote that publishes the release:
#
#   scripts/release-tag.sh vX.Y.Z [commit]
#   git push --atomic <remote> vX.Y.Z sdk/go/vX.Y.Z
#
# The release pipeline fails (job sdk-tag) when sdk/go/vX.Y.Z is missing or
# on another commit (docs/operations/ci.md, Releasing).
set -eu

version=${1:?usage: release-tag.sh vX.Y.Z [commit]}
commit=$(git rev-parse --verify "${2:-HEAD}^{commit}")
case $version in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "not a release version: $version (vX.Y.Z)" >&2; exit 2 ;;
esac
# The version in the release commit must be this one.
want=${version#v}
have=$(git show "$commit:desktop/package.json" | sed -n 's/^  "version": "\(.*\)",$/\1/p')
if [ "$have" != "$want" ]; then
  echo "desktop/package.json at $commit says $have, not $want: commit the release first" >&2
  exit 1
fi
for tag in "$version" "sdk/go/$version"; do
  if git rev-parse --verify --quiet "refs/tags/$tag" >/dev/null; then
    echo "tag $tag exists already" >&2
    exit 1
  fi
done
git tag -a "$version" -m "Cenacle $want" "$commit"
git tag -a "sdk/go/$version" -m "Cenacle Go SDK $want" "$commit"
echo "tagged $version and sdk/go/$version on $commit; push them with:"
echo "  git push --atomic <remote> $version sdk/go/$version"

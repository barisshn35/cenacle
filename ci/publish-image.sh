#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
#
# Publishes a release image built as an OCI archive (all platforms) to each
# registry under its version and minor tags (an existing version tag must
# already be this image: releases are never overwritten), then — when a signing key is
# set (COSIGN_KEY, COSIGN_PASSWORD) — signs it, and attaches a signed SPDX
# SBOM to the image of each platform. The SBOMs are written to $SBOM_DIR.
#
#   publish-image.sh <oci archive> <image name> <version> <docker config dir> <target>...
#
# Needs docker; uses the pinned skopeo, cosign and syft images. Signing uses
# no transparency log (ci/signing-config.json), so releases are verified with
# the project's public key alone, also without Internet (docs/security).
set -eu

archive=$1 image=$2 version=$3 auth=$4
shift 4
minor=${version%.*}
here=$(cd "$(dirname "$0")" && pwd)
: "${SKOPEO_IMAGE:?}" "${COSIGN_IMAGE:?}" "${SYFT_IMAGE:?}" "${SBOM_DIR:?}"
# Plain HTTP registries, for trying this out locally only.
insecure=${PUBLISH_INSECURE:-}

skopeo() {
  docker run --rm --network host -v "$archive:$archive:ro" -v "$auth:/auth:ro" -v "$SBOM_DIR:/out" \
    -e REGISTRY_AUTH_FILE=/auth/config.json "$SKOPEO_IMAGE" "$@"
}
cosign() {
  docker run --rm --user 0 --network host -v "$auth:/auth:ro" -v "$SBOM_DIR:/out" \
    -v "$here/signing-config.json:/signing-config.json:ro" -v "$COSIGN_KEY:/cosign.key:ro" \
    -e DOCKER_CONFIG=/auth -e COSIGN_PASSWORD "$COSIGN_IMAGE" "$@"
}
syft() {
  docker run --rm --user 0 --network host -v "$auth:/auth:ro" -v "$SBOM_DIR:/out" \
    -e DOCKER_CONFIG=/auth ${insecure:+-e SYFT_REGISTRY_INSECURE_USE_HTTP=true} "$SYFT_IMAGE" "$@"
}

signing=
if [ -n "${COSIGN_KEY:-}" ] && [ -n "${COSIGN_PASSWORD:-}" ]; then
  signing=1
else
  echo "COSIGN_KEY is not set: cenacle-$image $version is published unsigned"
fi
tls=${insecure:+--dest-tls-verify=false}
src_tls=${insecure:+--tls-verify=false}
http=${insecure:+--allow-http-registry}

mkdir -p "$SBOM_DIR"
# The digest of the image index in the archive, which skopeo pushes unchanged.
skopeo inspect --raw "oci-archive:$archive" > "$SBOM_DIR/.local"
local_digest=$(sha256sum < "$SBOM_DIR/.local" | cut -d' ' -f1)
rm -f "$SBOM_DIR/.local"
status=0
for target in "$@"; do
  # A version tag that exists already must be this very image (a re-run);
  # anything else would silently replace a published, maybe signed, release.
  if skopeo inspect --raw $src_tls "docker://$target:$version" > "$SBOM_DIR/.remote" 2>/dev/null; then
    remote_digest=$(sha256sum < "$SBOM_DIR/.remote" | cut -d' ' -f1)
    if [ "$remote_digest" != "$local_digest" ]; then
      echo "$target:$version exists with another image (sha256:$remote_digest); not overwriting"
      rm -f "$SBOM_DIR/.remote"
      status=1
      continue
    fi
  fi
  rm -f "$SBOM_DIR/.remote"
  # Each registry on its own: a failure on one still publishes and signs the others.
  pushed=1
  # skopeo uploads every platform manifest itself (buildkit trusts the
  # registry's "already there" for them, which GitLab's registry sometimes
  # gets wrong: "blob unknown to registry").
  for tag in "$version" "$minor"; do
    skopeo copy --all --retry-times 3 $tls --digestfile /out/.digest \
      "oci-archive:$archive" "docker://$target:$tag" || { pushed=; status=1; }
  done
  [ -n "$signing" ] && [ -n "$pushed" ] || continue
  digest=$(cat "$SBOM_DIR/.digest")
  rm -f "$SBOM_DIR/.digest"
  # The index and every image it names (platforms, build attestations).
  cosign sign --key /cosign.key --signing-config /signing-config.json --recursive --yes $http \
    "$target@$digest" || { status=1; continue; }
  index=$(skopeo inspect --raw $src_tls "docker://$target@$digest")
  for arch in $(printf '%s' "$index" | jq -r '.manifests[] | select(.platform.os == "linux") | .platform.architecture'); do
    platform_digest=$(printf '%s' "$index" | jq -r --arg a "$arch" \
      '.manifests[] | select(.platform.os == "linux" and .platform.architecture == $a) | .digest')
    sbom="cenacle-$image-$version-linux-$arch.spdx.json"
    # Made once, from the first registry that took the image.
    if [ ! -f "$SBOM_DIR/$sbom" ]; then
      syft -q "registry:$target@$platform_digest" -o "spdx-json=/out/$sbom" || { status=1; continue; }
    fi
    cosign attest --key /cosign.key --signing-config /signing-config.json --type spdxjson \
      --predicate "/out/$sbom" --yes $http "$target@$platform_digest" || status=1
  done
done
exit $status

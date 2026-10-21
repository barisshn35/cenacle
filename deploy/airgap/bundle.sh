#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
#
# Builds an offline bundle of every image the production stack uses (and,
# with --observability / --clamav, the optional ones) on a machine with
# internet access:
#
#   deploy/airgap/bundle.sh [--observability] [--clamav] [output-dir]
#
# Copy the output directory to the air-gapped host and run load.sh there.
# ClamAV still needs virus signatures: mirror them (see docs/install).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
compose_dir="$here/../compose"
files="-f prod.yml"
profiles=""
out=""
for arg in "$@"; do
  case "$arg" in
    --observability) files="$files -f observability.yml" ;;
    --clamav) profiles="$profiles --profile clamav" ;;
    -*) echo "unknown option $arg" >&2; exit 2 ;;
    *) out="$arg" ;;
  esac
done
env_file="$compose_dir/.env.prod"
[ -f "$env_file" ] || env_file="$compose_dir/.env.prod.example"
version=$(sed -n 's/^CENACLE_VERSION=//p' "$env_file")
out=${out:-"cenacle-airgap-$version"}
mkdir -p "$out"
out=$(cd "$out" && pwd)

cd "$compose_dir"
# The stack reads secrets/ only at runtime; placeholders let compose resolve it.
cleanup=""
if [ ! -d secrets ]; then
  mkdir secrets && : > secrets/garage.env && cleanup=secrets
fi
trap '[ -n "$cleanup" ] && rm -rf "${compose_dir:?}/$cleanup"' EXIT
dc() {
  # shellcheck disable=SC2086 # word splitting of the file and profile lists is intended
  docker compose $files $profiles --env-file "$env_file" "$@"
}
dc pull --ignore-buildable
dc build
images=$(dc config --images | sort -u)
echo "$images" > "$out/images.txt"
echo "saving $(echo "$images" | wc -l) images"
# shellcheck disable=SC2086 # one argument per image
docker save $images | gzip > "$out/images.tar.gz"
cp "$here/load.sh" "$out/load.sh"
(cd "$out" && sha256sum images.tar.gz images.txt load.sh > SHA256SUMS)
echo "bundle ready in $out"

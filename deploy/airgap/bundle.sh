#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
#
# Builds an offline bundle of every image the production stack uses (and,
# with --observability / --clamav / --backup, the optional ones) on a machine
# with internet access:
#
#   deploy/airgap/bundle.sh [--observability] [--clamav] [--backup] [output-dir]
#
# --backup adds the WAL-G image of backup.yml, which is built from sources on
# the internet. The bundle also holds empty files for every secret the stack
# reads (secrets/), to fill in or complete with gen-secrets.sh offline.
#
# Copy the output directory to the air-gapped host and run load.sh there.
# ClamAV still needs virus signatures: mirror them (see docs/install).
# Both hosts need Docker's containerd image store (see docs/operations).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
compose_dir=$(cd "$here/../compose" && pwd)
files="-f prod.yml"
profiles=""
backup=""
calls_bundle="" turn_bundle=""
out=""
for arg in "$@"; do
  case "$arg" in
    --observability) files="$files -f observability.yml" ;;
    --clamav) profiles="$profiles --profile clamav" ;;
    --backup) backup=1 ;;
    --calls) calls_bundle=1 ;;
    --calls-turn) calls_bundle=1; turn_bundle=1 ;;
    -*) echo "unknown option $arg" >&2; exit 2 ;;
    *) out="$arg" ;;
  esac
done
if [ -n "$calls_bundle" ]; then files="$files -f calls.yml"; fi
if [ -n "$turn_bundle" ]; then files="$files -f calls-turn.yml"; fi
# The classic image store re-creates the manifests it saves, so the digests
# prod.yml pins would not match on the offline host.
store=$(docker info --format '{{json .DriverStatus}}')
if ! echo "$store" | grep -q io.containerd.snapshotter; then
  echo "Docker's containerd image store is needed to save digest-pinned images (docs/operations)" >&2
  exit 1
fi
env_file="$compose_dir/.env.prod"
[ -f "$env_file" ] || env_file="$compose_dir/.env.prod.example"
version=$(sed -n 's/^CENACLE_VERSION=//p' "$env_file")
out=${out:-"cenacle-airgap-$version"}
mkdir -p "$out"
out=$(cd "$out" && pwd)
if [ "$out" = "$compose_dir" ]; then
  echo "choose an output directory other than deploy/compose" >&2
  exit 2
fi

cd "$compose_dir"
# The stack reads secrets/ only at runtime, but Compose reads the env files
# when it resolves the configuration: placeholders stand in for missing ones.
env_files="garage.env"
if [ -n "$backup" ]; then env_files="$env_files walg.env walg-postgres.env"; fi
made_dir=""
made_files=""
cleanup() {
  for f in $made_files; do rm -f "$compose_dir/secrets/$f"; done
  if [ -n "$made_dir" ]; then rmdir "$compose_dir/secrets"; fi
}
trap cleanup EXIT
if [ ! -d secrets ]; then
  mkdir secrets && made_dir=1
fi
for f in $env_files; do
  if [ ! -e "secrets/$f" ]; then
    : > "secrets/$f" && made_files="$made_files $f"
  fi
done
dc() {
  # shellcheck disable=SC2086 # word splitting of the file and profile lists is intended
  if [ -f .env.calls ]; then
    docker compose $files $profiles --env-file "$env_file" --env-file .env.calls "$@"
  else
    docker compose $files $profiles --env-file "$env_file" "$@"
  fi
}
dc pull --ignore-buildable
dc build
images=$(dc config --images)
config=$(dc config --format json)
if [ -n "$backup" ]; then
  # PostgreSQL with WAL-G (also used by walg-backup); the plain PostgreSQL
  # image stays in the bundle for installs without backup.yml.
  # shellcheck disable=SC2086 # word splitting of the file and profile lists is intended
  docker compose $files -f backup.yml $profiles --env-file "$env_file" build postgres
  # shellcheck disable=SC2086
  images="$images
$(docker compose $files -f backup.yml $profiles --env-file "$env_file" config --images)"
  # shellcheck disable=SC2086
  config="$config
$(docker compose $files -f backup.yml $profiles --env-file "$env_file" config --format json)"
fi
images=$(echo "$images" | sort -u)
echo "$images" > "$out/images.txt"
echo "saving $(echo "$images" | wc -l) images"
# shellcheck disable=SC2086 # one argument per image
docker save $images | gzip > "$out/images.tar.gz"
cp "$here/load.sh" "$out/load.sh"

# Empty files for the secrets the configuration names and its env files (never
# the contents of this machine's secrets/).
names=$( (echo "$config" | grep -o '"file": *"[^"]*/secrets/[^"/]*"' |
  sed 's/.*\/secrets\/\([^"]*\)"$/\1/'; echo "$env_files" | tr ' ' '\n') | sort -u)
mkdir -p "$out/secrets"
chmod 700 "$out/secrets"
for f in $names; do
  # Files already there (a re-used output directory) are kept as they are.
  if [ ! -e "$out/secrets/$f" ]; then
    : > "$out/secrets/$f"
    chmod 644 "$out/secrets/$f"
  fi
done
# The env files hold credentials only Compose reads.
for f in $env_files; do chmod 600 "$out/secrets/$f"; done

(cd "$out" && sha256sum images.tar.gz images.txt load.sh secrets/* > SHA256SUMS)
echo "bundle ready in $out ($(echo "$names" | wc -l) empty secret files in secrets/)"

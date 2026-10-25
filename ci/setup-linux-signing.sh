#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
#
# Sets up the signing of the desktop app's Linux packages, once: makes a new
# GPG key, keeps the private key and its passphrase only in the project's
# CI/CD variables (LINUX_GPG_KEY, LINUX_GPG_PASSPHRASE; protected) and writes
# the public key to deploy/cenacle-linux.asc, to be committed. Nothing secret
# is printed or kept on disk. v* tags must be protected (ci/setup-signing.sh
# does it). Running it again replaces the key.
#
#   GITLAB_URL=https://git.example.com GITLAB_PROJECT=group/cenacle \
#   GITLAB_TOKEN=<token with the api scope> ci/setup-linux-signing.sh
set -eu
: "${GITLAB_URL:?}" "${GITLAB_PROJECT:?}" "${GITLAB_TOKEN:?}"
# The desktop packaging image (.gitlab-ci.yml), which has GnuPG.
GPG_IMAGE=${GPG_IMAGE:-electronuserland/builder:22-wine-10.26@sha256:7e725c402e1a950b901263107da1c63afae9a2db02d5eed97102bd68f0decb59}
root=$(cd "$(dirname "$0")/.." && pwd)
project=$(printf '%s' "$GITLAB_PROJECT" | sed 's#/#%2F#g')
api="$GITLAB_URL/api/v4/projects/$project"

work=$(mktemp -d "${TMPDIR:-/dev/shm}/gpg.XXXXXX" 2>/dev/null || mktemp -d)
chmod 700 "$work"
trap 'rm -rf "$work"' EXIT INT TERM

passphrase=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
printf '%s' "$passphrase" > "$work/passphrase"
docker run --rm --network none -v "$work:/w" --entrypoint sh "$GPG_IMAGE" -c '
  set -e
  export GNUPGHOME=$(mktemp -d)
  gpg --batch --pinentry-mode loopback --passphrase-file /w/passphrase \
    --quick-gen-key "Cenacle desktop packages" rsa4096 sign 3y
  gpg --batch --pinentry-mode loopback --passphrase-file /w/passphrase \
    --armor --export-secret-keys > /w/private.asc
  gpg --armor --export > /w/public.asc
  chown "'"$(id -u)"'" /w/private.asc /w/public.asc'

put() {
  key=$1
  shift
  curl --fail --silent --show-error -o /dev/null -X DELETE -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
    "$api/variables/$key" 2>/dev/null || true
  curl --fail --silent --show-error -o /dev/null -X POST -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
    "$api/variables" --form "key=$key" --form "protected=true" "$@"
}
put LINUX_GPG_KEY --form "variable_type=file" --form "value=<$work/private.asc"
put LINUX_GPG_PASSPHRASE --form "masked=true" --form "value=$passphrase"

cp "$work/public.asc" "$root/deploy/cenacle-linux.asc"
echo "Linux package signing is set up. Commit deploy/cenacle-linux.asc."

#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Signs the desktop app's Linux packages with the project's GPG key when CI
# has it (LINUX_GPG_KEY, the armored private key file, and
# LINUX_GPG_PASSPHRASE; ci/setup-linux-signing.sh). Run from desktop/:
#   rpm   signs release/*.rpm (rpm checks it once the public key is imported)
#   sums  signs release/SHA256SUMS as SHA256SUMS.asc and adds the public key
set -eu
if [ -z "${LINUX_GPG_KEY:-}" ] || [ -z "${LINUX_GPG_PASSPHRASE:-}" ]; then
  echo "LINUX_GPG_KEY is not set: the Linux packages are not signed with GPG"
  exit 0
fi
GNUPGHOME=$(mktemp -d)
export GNUPGHOME
trap 'rm -rf "$GNUPGHOME"' EXIT INT TERM
pass="$GNUPGHOME/passphrase"
(umask 077 && printf '%s' "$LINUX_GPG_PASSPHRASE" > "$pass")
gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$pass" --import "$LINUX_GPG_KEY"
fpr=$(gpg --list-secret-keys --with-colons | awk -F: '/^fpr/ { print $10; exit }')
opts="--batch --pinentry-mode loopback --passphrase-file $pass -u $fpr"
case "${1:-}" in
  rpm)
    for f in release/*.rpm; do
      rpmsign --addsign --define "_gpg_name $fpr" --define "__gpg $(command -v gpg)" \
        --define "__gpg_sign_cmd %{__gpg} $opts --no-armor --detach-sign -o %{__signature_filename} %{__plaintext_filename}" \
        "$f" >/dev/null
    done
    ;;
  sums)
    gpg $opts --armor --detach-sign -o release/SHA256SUMS.asc release/SHA256SUMS
    gpg --armor --export "$fpr" > release/cenacle-linux.asc
    ;;
  *)
    echo "usage: $0 rpm|sums" >&2
    exit 2
    ;;
esac

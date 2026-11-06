#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Creates the call keys once: never prints them or rotates an existing one.
set -eu
cd "$(dirname "$0")"
command -v openssl >/dev/null 2>&1 || { echo 'OpenSSL is required to generate Ed25519 keys' >&2; exit 1; }
mkdir -p secrets
chmod 700 secrets
umask 077
for name in calls media_control; do
  private="secrets/${name}_private.pem"
  public="secrets/${name}_public.pem"
  if [ ! -s "$private" ]; then
    openssl genpkey -algorithm ED25519 -out "$private.new"
    mv "$private.new" "$private"
  fi
  if [ ! -s "$public" ]; then
    openssl pkey -in "$private" -pubout -out "$public.new"
    mv "$public.new" "$public"
  fi
  # Compose bind-mounted secrets are read by numeric non-root users. Parent 0700.
  chmod 644 "$private" "$public"
done
if [ ! -s secrets/media_turn_secret ]; then
  openssl rand -hex 32 > secrets/media_turn_secret
fi
chmod 644 secrets/media_turn_secret
echo 'Call keys ready; back up secrets with the database. TURN remains off.'

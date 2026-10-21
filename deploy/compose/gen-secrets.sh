#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
#
# Generates random secrets for deploy/compose/prod.yml into ./secrets.
# Existing files are kept, so re-running never rotates live credentials.
set -eu
cd "$(dirname "$0")"
# The directory is private to the owner (0700). Files are 0644 because Compose
# bind-mounts them with host permissions and the services run as non-root users.
mkdir -p secrets
chmod 700 secrets

rand() { head -c 32 /dev/urandom | base64 | tr -d '/+=\n' | cut -c1-40; }
keep_or_write() {
  [ -s "secrets/$1" ] || printf '%s' "$2" > "secrets/$1"
  chmod 644 "secrets/$1"
}

keep_or_write postgres_password "$(rand)"
keep_or_write chat_db_password "$(rand)"
keep_or_write idp_db_password "$(rand)"
keep_or_write valkey_password "$(rand)"

# Cenacle ID: key that encrypts token signing keys, cookie signing keys and the
# chat server's OIDC client secret.
keep_or_write idp_key_encryption_key "$(head -c 32 /dev/urandom | base64 | tr -d '\n')"
keep_or_write idp_cookie_keys "$(rand)$(rand)"
keep_or_write chat_client_secret "$(rand)$(rand)"

keep_or_write chat_database_url \
  "postgres://cenacle_chat:$(cat secrets/chat_db_password)@postgres:5432/cenacle_chat?sslmode=disable"
keep_or_write idp_database_url \
  "postgres://cenacle_idp:$(cat secrets/idp_db_password)@postgres:5432/cenacle_idp"

echo "secrets ready in $(pwd)/secrets (back them up together with the database)"

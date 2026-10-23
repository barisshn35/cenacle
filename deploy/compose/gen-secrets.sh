#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
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

# Garage (object store for files): its cluster secret, and the access key the
# chat server uses (Garage's key ids are "GK" and 24 hex digits).
hex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
keep_or_write garage_rpc_secret "$(hex 32)"
keep_or_write s3_access_key "GK$(hex 12)"
keep_or_write s3_secret_key "$(hex 32)"

# Optional credentials of services you connect (empty unless you write them in):
# the SMTP password and the AI model's API key.
for f in smtp_password ai_api_key; do
  [ -e "secrets/$f" ] || : > "secrets/$f"
  chmod 644 "secrets/$f"
done
# Garage reads its cluster secret and first key from the environment.
printf 'GARAGE_RPC_SECRET=%s\nGARAGE_DEFAULT_ACCESS_KEY=%s\nGARAGE_DEFAULT_SECRET_KEY=%s\n' \
  "$(cat secrets/garage_rpc_secret)" "$(cat secrets/s3_access_key)" "$(cat secrets/s3_secret_key)" \
  > secrets/garage.env
chmod 600 secrets/garage.env

# WAL-G's base backups (optional backup.yml) connect as postgres.
printf 'PGPASSWORD=%s\n' "$(cat secrets/postgres_password)" > secrets/walg-postgres.env
chmod 600 secrets/walg-postgres.env

# Grafana (optional observability.yml).
keep_or_write grafana_admin_password "$(rand)"

echo "secrets ready in $(pwd)/secrets (back them up together with the database)"

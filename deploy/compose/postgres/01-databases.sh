#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
#
# Creates the two application databases with separate owners:
# the chat backend and the identity server never share a database.
# Runs once, on the first start of an empty data volume.
set -eu

create_db() {
  user="$1"; password="$2"; db="$3"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
    -v user="$user" -v password="$password" -v db="$db" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'user', :'password') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'db', :'user') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db') \gexec
SQL
}

# Password from <NAME>_FILE (Docker secret) or from <NAME>.
secret() {
  file_var="$1_FILE"
  eval "file=\${$file_var:-}"
  if [ -n "$file" ]; then cat "$file"; else eval "printf '%s' \"\${$1:?$1 or $1_FILE is required}\""; fi
}

create_db "$CHAT_DB_USER" "$(secret CHAT_DB_PASSWORD)" "$CHAT_DB_NAME"
create_db "$IDP_DB_USER" "$(secret IDP_DB_PASSWORD)" "$IDP_DB_NAME"

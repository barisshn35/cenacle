#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Development only: a separate database for integration tests, so tests never
# touch development data.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v idp_owner="${IDP_DB_USER:-cenacle_idp}" -v chat_owner="${CHAT_DB_USER:-cenacle_chat}" <<'SQL'
SELECT format('CREATE DATABASE %I OWNER %I', 'cenacle_idp_test', :'idp_owner') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', 'cenacle_chat_test', :'chat_owner') \gexec
SQL

#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Development only: a separate database for integration tests, so tests never
# touch development data.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v owner="${IDP_DB_USER:-cenacle_idp}" <<'SQL'
SELECT format('CREATE DATABASE %I OWNER %I', 'cenacle_idp_test', :'owner') \gexec
SQL

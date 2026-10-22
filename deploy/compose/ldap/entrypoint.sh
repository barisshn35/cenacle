#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
set -eu

DATA=/var/lib/openldap/data
CONF=/tmp/slapd.conf

# The admin password comes from LDAP_ADMIN_PASSWORD or a Docker secret file.
if [ -n "${LDAP_ADMIN_PASSWORD_FILE:-}" ]; then
  LDAP_ADMIN_PASSWORD="$(cat "$LDAP_ADMIN_PASSWORD_FILE")"
fi
: "${LDAP_ADMIN_PASSWORD:?LDAP_ADMIN_PASSWORD or LDAP_ADMIN_PASSWORD_FILE is required}"

HASH="$(slappasswd -s "$LDAP_ADMIN_PASSWORD")"
sed "s|@ROOTPW@|$HASH|" /etc/openldap/slapd.conf > "$CONF"

if [ ! -f "$DATA/data.mdb" ]; then
  echo "seeding directory from /seed/*.ldif"
  for f in /seed/*.ldif; do slapadd -f "$CONF" -l "$f"; done
fi

exec slapd -f "$CONF" -h "ldap://0.0.0.0:3389/" -d "${LDAP_DEBUG_LEVEL:-256}"

# SPDX-License-Identifier: AGPL-3.0-only
#
# Test-only OpenLDAP server for local development (IdP LDAP connector, v0.14).
# Built from Alpine's maintained openldap packages; runs as the unprivileged
# "ldap" user on port 3389 and seeds itself from LDIF on first start.
FROM alpine:3.24.2

RUN apk add --no-cache openldap openldap-back-mdb openldap-clients \
 && mkdir -p /var/lib/openldap/data /run/openldap \
 && chown -R ldap:ldap /var/lib/openldap /run/openldap

COPY slapd.conf /etc/openldap/slapd.conf
COPY seed.ldif /seed/seed.ldif
COPY entrypoint.sh /entrypoint.sh

USER ldap
EXPOSE 3389
VOLUME ["/var/lib/openldap/data"]
HEALTHCHECK --interval=5s --timeout=3s --retries=20 \
  CMD ldapwhoami -x -H ldap://127.0.0.1:3389 >/dev/null || exit 1
ENTRYPOINT ["/entrypoint.sh"]

# SPDX-License-Identifier: Apache-2.0
# Reverse proxy with automatic TLS, running as an unprivileged user.
# Ports 80/443 are opened via the net.ipv4.ip_unprivileged_port_start sysctl
# in prod.yml, so no capabilities are needed.
FROM caddy:2.11.7-alpine
# Drop the binary's file capability: with cap_drop ALL and no-new-privileges a
# file capability makes exec fail, and low ports are opened by sysctl instead.
RUN apk add --no-cache libcap && setcap -r /usr/bin/caddy && apk del libcap \
 && adduser -D -H -u 10001 cenacle && chown -R cenacle:cenacle /data /config
COPY Caddyfile /etc/caddy/Caddyfile
USER cenacle

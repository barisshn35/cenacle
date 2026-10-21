# Installing Cenacle (self-hosted)

This guide covers a single-host installation with Docker Compose
([`deploy/compose/prod.yml`](../../deploy/compose/prod.yml)). v0.1 ships the stack
skeleton; sign-in and messaging arrive in later releases.

## Requirements

- Linux host (amd64 or arm64), Docker Engine with Compose v2.24+
- Two DNS names pointing to the host, for example `chat.example.com` (Cenacle) and
  `id.example.com` (Cenacle ID)
- Ports 80 and 443 free on the host (no other web server bound to them)

## Steps

```sh
git clone https://github.com/barisshn35/cenacle.git && cd cenacle/deploy/compose
./gen-secrets.sh                      # random passwords into ./secrets (kept on re-run)
cp .env.prod.example .env.prod        # set CENACLE_DOMAIN, CENACLE_ID_DOMAIN, ACME_EMAIL, version
docker compose -f prod.yml --env-file .env.prod up -d
docker compose -f prod.yml --env-file .env.prod ps     # every service healthy
```

Back up `secrets/` and `.env.prod` together with the databases
([backup guide](../backup/README.md)).

## Firewall

### Inbound

| Port    | Required           | Purpose                                                   |
| ------- | ------------------ | --------------------------------------------------------- |
| 80/tcp  | yes                | Let's Encrypt HTTP-01 validation and redirect to HTTPS    |
| 443/tcp | yes                | Web app, API, WebSocket and Cenacle ID (all behind Caddy) |
| 443/udp | recommended        | HTTP/3 (QUIC); browsers fall back to HTTP/2 when closed   |
| 22/tcp  | for administration | SSH; restrict to your management addresses                |

Nothing else needs to be reachable. PostgreSQL and Valkey are only attached to the
internal `data` network and are never published; the chat server, Cenacle ID and the web
container are only reachable through Caddy.

### Outbound

| Destination                                  | When                                                    |
| -------------------------------------------- | ------------------------------------------------------- |
| DNS (53/udp, 53/tcp)                         | always                                                  |
| Let's Encrypt (443/tcp)                      | certificate issuance and renewal                        |
| Container registry, e.g. `ghcr.io` (443/tcp) | installing and upgrading images (not needed air-gapped) |
| SMTP relay (587 or 465/tcp)                  | e-mail features (v0.8+)                                 |
| LDAP / Active Directory (389 or 636/tcp)     | directory sign-in (v0.14)                               |

### Things to know

1. **Docker bypasses host firewalls such as UFW and firewalld** for published ports: it
   writes its own iptables rules. A port published in a compose file is reachable even if
   the host firewall "blocks" it. `prod.yml` publishes only 80 and 443; keep it that way.
   To restrict published ports further, add rules to the `DOCKER-USER` chain.
2. **IPv6:** if the host has a public IPv6 address, apply the same rules for IPv6 and add
   `AAAA` records only when IPv6 is allowed through.
3. **DNS first:** both host names must resolve to the host before the first start,
   otherwise Caddy cannot obtain certificates (it retries automatically).
4. **Air-gapped networks:** without access to Let's Encrypt, provide your own certificates
   (company CA) to Caddy instead of automatic issuance; move images with
   `docker save` / `docker load`. See the [upgrade guide](../upgrade/README.md).
5. **Sharing a host:** if another reverse proxy already owns 80/443, either install Cenacle
   on a separate host or put it behind that proxy (forward both host names to Caddy on an
   internal port and remove the published ports from `prod.yml`).

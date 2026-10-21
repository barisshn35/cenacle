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
cp .env.prod.example .env.prod        # set domains, ACME_EMAIL, version, administrator, channels
docker compose -f prod.yml --env-file .env.prod up -d
docker compose -f prod.yml --env-file .env.prod ps     # every service healthy
```

Back up `secrets/` and `.env.prod` together with the databases
([backup guide](../backup/README.md)).

### Administrator and default channels

Set these in `.env.prod` before the first start (they can be changed later; the server
applies them at every start):

| Setting                        | Default   | Meaning                                                                                                                               |
| ------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `CENACLE_ADMIN_EMAIL`          | (none)    | The Cenacle ID account (verified e-mail address) of the instance administrator: creates workspaces and owns the default workspace.    |
| `CENACLE_ANNOUNCEMENT_CHANNEL` | `Central` | Created for everyone; nobody can leave it and only the administrator posts there. Empty: no announcement channel.                     |
| `CENACLE_DEFAULT_CHANNELS`     | `General` | Comma-separated channels created for everyone. People can leave them and join again.                                                  |
| `CENACLE_EGRESS_ALLOW`         | (none)    | Comma-separated private networks bots may be reached in (slash commands, event deliveries); internal addresses are refused otherwise. |

These channels belong to the default workspace. Everyone who signs in joins the default
workspace and these channels, also later. Inside a workspace, owners and admins create
channels and invite people with links; see the workspace menu in the sidebar. Changing
`CENACLE_ADMIN_EMAIL` moves the administrator flag when the new account signs in; the old
account loses it at the next start.

### Files

Files are stored in the bundled Garage (an S3-compatible object store; AGPL-3.0, run as its
own service and reached only over S3). Browsers upload straight to it through Caddy, with a
form the server signs for one file of an exact size; downloads go through the server, which
checks access first. Settings (in `.env.prod`):

| Setting                     | Default                      | Meaning                                                                                                                                 |
| --------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `CENACLE_FILES_MAX_SIZE_MB` | `100`                        | The largest file.                                                                                                                       |
| `CENACLE_S3_ENDPOINT`       | `http://garage:3900`         | Another S3 service instead of Garage (then also `CENACLE_S3_UPLOAD_URL` and the keys).                                                  |
| `CENACLE_S3_BUCKET`         | `cenacle-files`              | The bucket; Caddy passes uploads to `/<bucket>/` on the chat domain.                                                                    |
| `CENACLE_S3_UPLOAD_URL`     | `https://<domain>/<bucket>/` | Where browsers post uploads. For an external S3 service, its bucket URL; allow `POST` from the app's origin in the bucket's CORS rules. |
| `CENACLE_CLAMAV_ADDR`       | (none)                       | A clamd to scan every file, e.g. `clamav:3310` with `--profile clamav`. Rejected files are deleted.                                     |

Without `CENACLE_S3_ENDPOINT` files are off and the app hides the attach button.

Virus scanning: start the stack with `--profile clamav` and set
`CENACLE_CLAMAV_ADDR=clamav:3310`. ClamAV (GPL-2.0) runs as its own container, downloads
virus signatures on start and keeps them current; in air-gapped networks, point it at a
local signature mirror. Its `StreamMaxLength` must be at least `CENACLE_FILES_MAX_SIZE_MB`.

### First account and Cenacle ID operations

Cenacle ID has no self-registration yet. Create accounts with its CLI (the password is
read from stdin, never from the command line); create the administrator's account with the
address in `CENACLE_ADMIN_EMAIL` and `--verified`:

```sh
docker compose -f prod.yml --env-file .env.prod run --rm -T idp \
  node dist/cli.js users create --email you@example.com --name "Your Name" --verified
docker compose -f prod.yml --env-file .env.prod run --rm -T idp \
  node dist/cli.js users set-password --email you@example.com
```

Token signing keys are created on first start. Rotate them periodically; the previous key
stays published for the grace period (default 7 days) so issued tokens keep verifying:

```sh
docker compose -f prod.yml --env-file .env.prod run --rm idp node dist/cli.js keys rotate
docker compose -f prod.yml --env-file .env.prod restart idp
docker compose -f prod.yml --env-file .env.prod run --rm idp node dist/cli.js keys prune
```

Registered applications are listed in `deploy/compose/idp/clients.json`; host names use
`${CENACLE_DOMAIN}` from `.env.prod`. `backchannel_logout_uri` is where Cenacle ID tells the
chat server that a sign-in ended (an internal address of the compose network).

Users turn on two-step verification (an authenticator app plus recovery codes) at
`https://<id-domain>/account`; the app links there from Settings.

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
| ClamAV signature mirror (443/tcp)            | only with the optional virus scanner (`clamav` profile) |
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
4. **Certificates without Let's Encrypt:** set `CENACLE_TLS_MODE` in `.env.prod`:
   `files` loads your own certificate from `deploy/compose/certs/tls.crt` (full chain) and
   `tls.key`; `internal` uses Caddy's internal CA (clients must trust it). In air-gapped
   networks move images with `docker save` / `docker load`
   (see the [upgrade guide](../upgrade/README.md)).
5. **Sharing a host:** if another reverse proxy already owns 80/443, either install Cenacle
   on a separate host or put it behind that proxy (forward both host names to Caddy on an
   internal port and remove the published ports from `prod.yml`).

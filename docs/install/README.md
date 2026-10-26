# Installing Cenacle (self-hosted)

This guide covers a single-host installation with Docker Compose
([`deploy/compose/prod.yml`](../../deploy/compose/prod.yml)). For Kubernetes, see
[Kubernetes](kubernetes.md).

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

Images come from `git.calaixo.com:5050/calaxio/cenacle` (`CENACLE_IMAGE_PREFIX`). If the
registry asks for credentials, `docker login git.calaixo.com:5050` once before `up`.

Every setting can also be read from a file: `CENACLE_X_FILE=/run/secrets/x` instead of
`CENACLE_X` (the same for `IDP_*`); setting both is an error. `prod.yml` reads the
credentials from `secrets/` this way. `secrets/smtp_password` and `secrets/ai_api_key`
start empty; write the password or key either there or into `.env.prod`
(`CENACLE_SMTP_PASSWORD`, `CENACLE_AI_API_KEY`). An empty file does not count as set, so
only both with content is an error.

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
| `CENACLE_FILES_BACKEND`     | `s3`                         | Where files are kept: `s3`, `azure` (Azure Blob Storage), `dir` (a directory of the server) or `off`.                                   |
| `CENACLE_S3_ENDPOINT`       | `http://garage:3900`         | Another S3 service instead of Garage (then also `CENACLE_S3_UPLOAD_URL` and the keys); empty: files are off.                            |
| `CENACLE_S3_REGION`         | `garage`                     | The region the S3 service expects.                                                                                                      |
| `CENACLE_S3_BUCKET`         | `cenacle-files`              | The bucket; Caddy passes uploads to `/<bucket>/` on the chat domain.                                                                    |
| `CENACLE_S3_UPLOAD_URL`     | `https://<domain>/<bucket>/` | Where browsers post uploads. For an external S3 service, its bucket URL; allow `POST` from the app's origin in the bucket's CORS rules. |
| `CENACLE_CLAMAV_ADDR`       | (none)                       | A clamd to scan every file, e.g. `clamav:3310` with the `clamav` profile. Rejected files are deleted.                                   |

With `CENACLE_S3_ENDPOINT=` (empty) or `CENACLE_FILES_BACKEND=off` files are off and the
app hides the attach button.

Garage runs in every stack (it is small); with files kept elsewhere it simply stays
unused.

An S3 service on another origin than the chat domain: also set `CENACLE_UPLOAD_ORIGIN` to
that origin (for example `https://s3.example.com`), which the web app's content security
policy then allows browsers to upload to.

**Azure Blob Storage:** set `CENACLE_FILES_BACKEND=azure`, `CENACLE_AZURE_ACCOUNT`,
`CENACLE_AZURE_CONTAINER` (default `cenacle-files`, which must exist) and write the account
key into `secrets/azure_key`; `CENACLE_AZURE_ENDPOINT` names another cloud or an emulator.
**A directory:** `CENACLE_FILES_BACKEND=dir`; `prod.yml` keeps the files on the
`files-data` volume at `CENACLE_FILES_DIR` (default `/data/files`). Every chat server must
mount the same one (on several hosts: shared storage). With both, browsers upload to
the chat server (`/api/uploads`, with a one-time ticket for the file's key and size), which
writes the file; garage and the `/<bucket>/` route are then not needed. Keep the timeouts of
a proxy in front long enough for the largest file.

Virus scanning: start the stack with `--profile clamav` and set
`CENACLE_CLAMAV_ADDR=clamav:3310`. ClamAV (GPL-2.0) runs as its own container, downloads
virus signatures on start and keeps them current; in air-gapped networks, point it at a
local signature mirror. Its `StreamMaxLength` must be at least `CENACLE_FILES_MAX_SIZE_MB`.

### Notifications

People choose their notifications in Settings → Notifications. Two features need the
server's help:

| Setting                    | Default    | Meaning                                                                                                 |
| -------------------------- | ---------- | ------------------------------------------------------------------------------------------------------- |
| `CENACLE_SMTP_HOST`        | (none)     | SMTP server for e-mail about missed mentions and direct messages; empty: no e-mail.                     |
| `CENACLE_SMTP_PORT`        | `587`      | Its port.                                                                                               |
| `CENACLE_SMTP_SECURITY`    | `starttls` | `starttls`, `tls` (port 465) or `none` (only for a relay on a trusted network).                         |
| `CENACLE_SMTP_USERNAME`    | (none)     | Sign-in, if the server asks for one (password in `CENACLE_SMTP_PASSWORD` or `secrets/smtp_password`).   |
| `CENACLE_SMTP_FROM`        | (none)     | Sender, e.g. `Cenacle <chat@example.com>`; required with a host.                                        |
| `CENACLE_WEB_PUSH`         | `false`    | Notifications on devices where Cenacle is closed, through the browser makers' push services (internet). |
| `CENACLE_WEB_PUSH_SUBJECT` | (none)     | A `mailto:` or `https:` contact for the push services; default: `mailto:` and `CENACLE_ADMIN_EMAIL`.    |

### Other settings

| Setting                        | Default              | Meaning                                                                                                                                                               |
| ------------------------------ | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CENACLE_LINK_PREVIEWS`        | `true`               | The server fetches public pages linked in messages for previews; `false` without internet access.                                                                     |
| `CENACLE_DATABASE_MAX_CONNS`   | `25`                 | Database connections per chat server ([performance](../operations/performance.md)).                                                                                   |
| `CENACLE_DRAIN_DELAY`          | `5s`                 | A stopping chat server keeps serving this long while the proxy moves away (upgrades without errors).                                                                  |
| `CENACLE_SESSION_IDLE_TIMEOUT` | `none`               | A signed-in device ends after this long unused (`none`: never; people stay signed in until they sign out).                                                            |
| `CENACLE_SESSION_MAX_AGE`      | `none`               | ... and after this long at the latest (`none`: no maximum).                                                                                                           |
| `CENACLE_WEB_APP`              | unset                | `on` or `off` overrides the administrators' web app setting (recovery); unset leaves it to them.                                                                      |
| `CENACLE_DESKTOP_MIN_VERSION`  | unset                | The oldest desktop app accepted (for example `0.30.0`); older apps ask to update first.                                                                               |
| `CENACLE_PRIVACY_URL`          | unset                | Your privacy policy for this server, linked from Settings → Account (see [privacy](../privacy.md)).                                                                   |
| `CENACLE_SOURCE_URL`           | Cenacle's repository | The source code of this server, linked from Settings → Account. AGPL-3.0 asks a changed Cenacle offered over a network to offer its changed source: point this at it. |
| `CENACLE_LOG_LEVEL`            | `info`               | `debug`, `info`, `warn` or `error` (`IDP_LOG_LEVEL` for Cenacle ID).                                                                                                  |
| `CENACLE_AI_URL`, `_MODEL`     | (none)               | Optional AI with a model you run; see the [AI guide](../operations/ai.md).                                                                                            |
| `IDP_LOGIN_RATE_LIMIT`         | `10`                 | Sign-in attempts per address and minute; raise it when many people share one public address.                                                                          |
| `IDP_COOKIE_DOMAIN`            | (none)               | Share Cenacle ID's cookies across subdomains, e.g. `example.com`.                                                                                                     |

Cenacle ID keeps up to 10 database connections (`IDP_DATABASE_POOL_MAX`); keep the sum of
all chat servers' and Cenacle ID's connections below PostgreSQL's `max_connections`.

The chat server's root file system is read-only; archive exports and imports are staged
in `/tmp`, a memory file system of `CENACLE_TMP_SIZE` (default `1g`, counted against the
server's memory). For exports or imports larger than that, raise it, or mount a volume at
`/tmp` in a compose override (or point `TMPDIR` at a mounted volume).

### First account and Cenacle ID operations

Cenacle ID has no self-registration yet. Create accounts with its CLI; create the
administrator's account with the address in `CENACLE_ADMIN_EMAIL` and `--verified`. It asks
for the password twice, without showing it (a password never goes on the command line):

```sh
docker compose -f prod.yml --env-file .env.prod run --rm idp \
  node dist/cli.js users create --email you@example.com --name "Your Name" --verified
```

To set a new password later, run `users set-password --email you@example.com` the same way.
In a script, add `-T` after `run` and give the password on stdin, for example from a file
(`< password-file`); it is then read once.

Token signing keys are created on first start. Rotate them periodically; the previous key
stays published for the grace period (`IDP_KEY_RETIRED_GRACE_SECONDS`, default 7 days) so
issued tokens keep verifying:

```sh
docker compose -f prod.yml --env-file .env.prod run --rm idp node dist/cli.js keys rotate
docker compose -f prod.yml --env-file .env.prod restart idp
docker compose -f prod.yml --env-file .env.prod run --rm idp node dist/cli.js keys prune
```

Registered applications are listed in `deploy/compose/idp/clients.json`; host names use
`${CENACLE_DOMAIN}` from `.env.prod`. `backchannel_logout_uri` is where Cenacle ID tells the
chat server that a sign-in ended (an internal address of the compose network).

By default everyone signs in with a password and a code from an authenticator app: people
without one set it up during their first sign-in (QR code, a code, ten recovery codes).
Passkeys are off. Administrators change both in Cenacle ID's administration, Sign-in
(`https://<id-domain>/account/admin/sign-in`); people manage their own at
`https://<id-domain>/account`, which the app links from Settings. Sessions last until people
sign out (see `CENACLE_SESSION_*` above). Server administrators can turn the web app off in
Settings, Sign-in; `CENACLE_WEB_APP=on` turns it back on.

Directories (Active Directory, LDAP), other identity providers (OpenID Connect, SAML) and
directory groups: see [Identity](identity.md).

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

| Destination                                 | When                                                    |
| ------------------------------------------- | ------------------------------------------------------- |
| DNS (53/udp, 53/tcp)                        | always                                                  |
| Let's Encrypt (443/tcp)                     | certificate issuance and renewal                        |
| Container registry (`git.calaixo.com:5050`) | installing and upgrading images (not needed air-gapped) |
| SMTP relay (587 or 465/tcp)                 | e-mail about missed messages (`CENACLE_SMTP_HOST`)      |
| Public web sites (80, 443/tcp)              | link previews (`CENACLE_LINK_PREVIEWS`, on by default)  |
| Bots' and workflows' servers (443/tcp)      | slash commands, event deliveries, workflow webhooks     |
| Other Cenacle servers (443/tcp)             | only with federation (shared channels)                  |
| Your AI model server                        | only with AI (`CENACLE_AI_URL`)                         |
| Browser push services (443/tcp)             | only with web push turned on (`CENACLE_WEB_PUSH`)       |
| ClamAV signature mirror (443/tcp)           | only with the optional virus scanner (`clamav` profile) |
| LDAP / Active Directory (389 or 636/tcp)    | directory sign-in                                       |
| Identity providers (443/tcp)                | sign-in with OpenID Connect or SAML providers           |

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

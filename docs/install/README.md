# Installing Cenacle (self-hosted)

This guide covers a single-host installation with Docker Compose
([`deploy/compose/prod.yml`](../../deploy/compose/prod.yml)). For Kubernetes, see
[Kubernetes](kubernetes.md).

## Requirements

- A Linux server (amd64 or arm64) with Docker Engine and Compose v2.24+, at least 2 GB of
  memory (4 GB or more for daily use) and 10 GB free disk for Docker's data. The
  distributions Cenacle targets on servers are **Ubuntu 22.04 and 24.04, Debian 12 and 13,
  AlmaLinux 9 and 10 and Rocky Linux 9 and 10**. On each, on 2026-11-05, `install.sh`
  (below) installed the stack from scratch (every service healthy, the chat server, the web
  app and Cenacle ID answering through the proxy) and a second run changed nothing; Docker
  Engine came from Docker's repository. **These tests ran in containers, not on machines:**
  each distribution as a container with its own Docker Engine, on the test host's kernel
  (Linux 6.8, amd64), so they did not cover a reboot, SELinux in enforcing mode, firewalld
  or the distribution's own kernel. There was no test on real machines (the project owner's
  decision for 1.0). Other distributions may work but were not tested; `install.sh` says so
  and goes on. (The desktop app's Linux packages are a separate matter: [desktop
  app](desktop.md).)
- Two DNS names pointing to the host, for example `chat.example.com` (Cenacle) and
  `id.example.com` (Cenacle ID)
- Ports 80 and 443 free on the host (no other web server bound to them)
- The host's clock kept right (NTP, for example systemd-timesyncd or chrony): two-step
  codes are accepted within 30 seconds of the right time, and sign-in tokens carry their
  times too

## Installing with install.sh

`install.sh` does the steps of the next section on one host. Each release from 1.0.0 on
carries it on [GitHub Releases](https://github.com/Cenacle-TR/cenacle/releases), with the
deployment files (`cenacle-compose-<version>.tar.gz`) and the signed checksums. Download,
verify, then run it; do not pipe a download into a shell:

```sh
v=1.0.0
base=https://github.com/Cenacle-TR/cenacle/releases/download/v$v
mkdir "cenacle-$v" && cd "cenacle-$v"
curl -fLO "$base/install.sh" -O "$base/cenacle-compose-$v.tar.gz" \
  -O "$base/SHA256SUMS" -O "$base/SHA256SUMS.sigstore.json"
curl -fLO "https://raw.githubusercontent.com/Cenacle-TR/cenacle/v$v/deploy/cosign.pub"
cosign verify-blob --key cosign.pub --insecure-ignore-tlog \
  --bundle SHA256SUMS.sigstore.json SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS
sudo sh install.sh
```

It checks the archive against `SHA256SUMS` again, unpacks it into
`/opt/cenacle/cenacle-compose-<version>` (`--dir` for another place) and works there. From
a git checkout, run `deploy/compose/install.sh` instead; it then uses that directory.

What it does, in order:

1. **Looks at the host, not at the distribution's name:** Docker Engine (installed and
   running), Compose 2.24 or later, the processor (amd64 or arm64), memory (stops below
   2 GB, warns below 4 GB), free disk (10 GB for Docker's data and for the deployment
   directory), and that nothing else listens on 80/tcp, 443/tcp and 443/udp. When something
   is missing it lists all of it, says what to do and stops. **It never installs Docker**:
   it points to [Docker's installation guide](https://docs.docker.com/engine/install/). On
   a distribution not listed above it warns "this distribution was not tested" and goes
   on.
2. **SELinux:** when SELinux is in enforcing mode, `install.sh` **switches it to
   permissive**: now (`setenforce 0`) and after restarts (`SELINUX=permissive` in
   `/etc/selinux/config`; never `disabled`). It first copies the file to
   `/etc/selinux/config.before-cenacle-<time>`, and prints what it changed and how to undo
   it (`cp -p <copy> /etc/selinux/config && setenforce 1`), also into the install log. With
   **`--keep-selinux`** it leaves SELinux as it is and only warns: Cenacle's containers were
   not tested with SELinux enforcing.
3. **Firewall:** it reports whether firewalld or ufw is active but **never changes firewall
   rules**; open the ports in [Firewall](#firewall) yourself.
4. **Settings and secrets:** it asks for the chat's and Cenacle ID's host names, the
   administrator's e-mail address and the TLS mode (and Let's Encrypt's e-mail), writes
   `.env.prod` (mode 0600) from `.env.prod.example`, and runs `gen-secrets.sh`. An existing
   `.env.prod` or secret is never overwritten. Without questions:
   `--yes --domain chat.example.com --id-domain id.example.com --admin-email you@example.com`
   (and `--tls-mode`, `--acme-email`).
5. **Start:** `docker compose up -d`, then it waits (up to 10 minutes, `--wait`) until every
   service is healthy and the one-time jobs have finished, and checks `/readyz` through the
   proxy. If a service is not ready it names it and shows the end of its log.

Everything it prints also goes to `install.log` in the deployment directory. Running it
again is safe: it keeps the unpacked files, `.env.prod` and the secrets, and `docker
compose up -d` leaves running services as they are. `sh install.sh --help` lists the
options.

The manual steps below remain the reference; `install.sh` follows them.

**Live captions in calls** (optional, ADR 0052): `--captions base` or `--captions small`
(with `--calls`) adds a speech to text service on this host, whisper.cpp's server with a
Whisper model, in the `captions.yml` overlay. `install.sh` downloads the model into
`captions-models/` and checks its SHA-256; without internet, copy `ggml-base.bin` or
`ggml-small.bin` there before running it. *base* (148 MB) is quicker, *small* (488 MB)
understands Turkish better and needs more processor time; the service uses up to 4 CPUs and
3 GB of memory (`CENACLE_CAPTIONS_CPUS`, `CENACLE_CAPTIONS_THREADS` in `.env.calls`). Audio
and text stay on this host and are not stored. Each workspace's administrators then allow
captions in its call settings.

## Installing by hand

1. Get the deployment files:

   ```sh
   git clone https://github.com/Cenacle-TR/cenacle.git && cd cenacle/deploy/compose
   ```

2. Make the secrets: `./gen-secrets.sh` writes random passwords into `./secrets` (kept on
   re-run).
3. Copy the settings: `cp .env.prod.example .env.prod`.
4. Edit `.env.prod`: domains, `ACME_EMAIL` (with the default TLS mode `acme`), version,
   administrator, channels.
5. Start: `docker compose -f prod.yml --env-file .env.prod up -d`.
6. Check: `docker compose -f prod.yml --env-file .env.prod ps` shows every service healthy,
   and `https://<chat-domain>/readyz` answers `200` from the chat server.
7. Create the first administrator in Cenacle ID (see below) and sign in once to set up
   two-step verification.

Before the first start, both host names need DNS records (Things to know, 3).

Images come from GitHub's container registry, `ghcr.io/cenacle-tr` (`CENACLE_IMAGE_PREFIX`).
From 1.0.0 the repository and the registry are public: `git clone` and `docker pull` need no
sign-in. Release candidates before 1.0.0 are not published there: build their images from
the release tag of the source you were given (`git checkout v<version> && make images`, which names them
`cenacle-<name>:dev`), then set `CENACLE_IMAGE_PREFIX=cenacle-` and `CENACLE_VERSION=dev`
and skip `pull`.
`ACME_EMAIL` is needed only with
`CENACLE_TLS_MODE=acme`: without it the proxy does not start, and its log says so. With
`internal` and `files` it may stay empty. The proxy's
health check shows only that Caddy runs with its configuration, not that certificates were
issued. `prod.yml` names the project `cenacle`; to run a second stack on the same host, give it
another name with `COMPOSE_PROJECT_NAME=<name>` in the environment (or `-p <name>`), and
use the same name for every later command, upgrades and backups included.

Every setting can also be read from a file: `CENACLE_X_FILE=/run/secrets/x` instead of
`CENACLE_X`, and `IDP_X_FILE` instead of `IDP_X`; line breaks at the end of the file are
dropped. `prod.yml` reads the credentials from `secrets/` this way. The two services treat a
setting given both ways differently:

- **Chat server (`CENACLE_*`):** when both are given, an empty `CENACLE_X` does not count
  (the file is read), and neither does a file holding only blanks when `CENACLE_X` has a
  value; only both with content (or a file that cannot be read) is an error.
  `secrets/smtp_password` and `secrets/ai_api_key` start empty, so write the password or
  key either there or into `.env.prod` (`CENACLE_SMTP_PASSWORD`, `CENACLE_AI_API_KEY`).
- **Cenacle ID (`IDP_*`):** defining both `IDP_X` and `IDP_X_FILE` is an error, even when
  one of them is empty. An empty `IDP_X` without a file counts as unset.

Back up `secrets/` and `.env.prod` together with the databases
([backup guide](../backup/README.md)).

### Administrator and default channels

Set these in `.env.prod` before the first start (they can be changed later; the server
applies them at every start):

| Setting                        | Default   | Meaning                                                                                                                                                                                                             |
| ------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CENACLE_ADMIN_EMAIL`          | (none)    | The Cenacle ID account (verified e-mail address) of the instance administrator: creates workspaces and owns the default workspace.                                                                                  |
| `CENACLE_ANNOUNCEMENT_CHANNEL` | `Central` | Created for everyone; nobody can leave it and only the administrator posts there. Empty: no announcement channel.                                                                                                   |
| `CENACLE_DEFAULT_CHANNELS`     | `General` | Comma-separated channels created for everyone. People can leave them and join again.                                                                                                                                |
| `CENACLE_EGRESS_ALLOW`         | (none)    | Comma-separated private networks bots may be reached in (slash commands, event deliveries); internal addresses are refused otherwise.                                                                               |
| `CENACLE_EGRESS_ALLOW_HTTP`    | `false`   | `true` also allows plain `http://` addresses for bots, workflows, feeds, federation and the SIEM stream (default: `https://` only). For development or closed networks; link previews and web push stay https-only. |

These channels belong to the default workspace. Everyone who signs in joins the default
workspace and these channels, also later. Inside a workspace, owners and admins create
channels and invite people with links; see the workspace menu in the sidebar. Changing
`CENACLE_ADMIN_EMAIL` moves the administrator flag when the new account signs in; the old
account loses it at the next start.

### Files

Files are stored in the bundled Garage (an S3-compatible object store; AGPL-3.0, run as its
own service and reached only over S3). Browsers upload straight to it through Caddy, with a
form the server signs for one file of an exact size; downloads go through the server, which
checks access first. Settings (in `.env.prod`); the server's own default and the value
`prod.yml` passes differ for some of them, and the second is what a Compose installation
gets when `.env.prod` does not set it:

| Setting                     | Server default                                             | `prod.yml`                   | Meaning                                                                                                                                 |
| --------------------------- | ---------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `CENACLE_FILES_MAX_SIZE_MB` | `100`                                                      | `100`                        | The largest file.                                                                                                                       |
| `CENACLE_FILES_BACKEND`     | unset: `s3` if `CENACLE_S3_ENDPOINT` is set, off otherwise | unset (so `s3`, with Garage) | Where files are kept: `s3`, `azure` (Azure Blob Storage), `dir` (a directory of the server) or `off`.                                   |
| `CENACLE_S3_ENDPOINT`       | (none)                                                     | `http://garage:3900`         | Another S3 service instead of Garage (then also `CENACLE_S3_UPLOAD_URL` and the keys); empty: files are off.                            |
| `CENACLE_S3_REGION`         | `garage`                                                   | `garage`                     | The region the S3 service expects.                                                                                                      |
| `CENACLE_S3_BUCKET`         | `cenacle-files`                                            | `cenacle-files`              | The bucket; Caddy passes uploads to `/<bucket>/` on the chat domain.                                                                    |
| `CENACLE_S3_UPLOAD_URL`     | `<CENACLE_PUBLIC_URL>/<bucket>/`                           | `https://<domain>/<bucket>/` | Where browsers post uploads. For an external S3 service, its bucket URL; allow `POST` from the app's origin in the bucket's CORS rules. |
| `CENACLE_FILES_DIR`         | (none; required with `dir`)                                | `/data/files`                | The directory of the `dir` backend (an absolute path).                                                                                  |
| `CENACLE_CLAMAV_ADDR`       | (none)                                                     | (none)                       | A clamd to scan every file, e.g. `clamav:3310` with the `clamav` profile. Rejected files are deleted.                                   |

With `CENACLE_S3_ENDPOINT=` (empty) and no `CENACLE_FILES_BACKEND`, or with
`CENACLE_FILES_BACKEND=off`, files are off and the app hides the attach button.

The Helm chart starts from the server's defaults: files stay off until `s3.endpoint` or
`files.backend` is set, and the `dir` backend always uses `/data/files`
([Kubernetes](kubernetes.md)).

Garage runs in every stack (it is small); with files kept elsewhere it simply stays
unused.

An S3 service on another origin than the chat domain: also set `CENACLE_UPLOAD_ORIGIN` to
that origin (for example `https://s3.example.com`), which the web app's content security
policy then allows browsers to upload to.

**Azure Blob Storage:** set `CENACLE_FILES_BACKEND=azure`, `CENACLE_AZURE_ACCOUNT`,
`CENACLE_AZURE_CONTAINER` (default `cenacle-files`, which must exist) and write the account
key into `secrets/azure_key`; `CENACLE_AZURE_ENDPOINT` names another cloud or an emulator.
**A directory:** `CENACLE_FILES_BACKEND=dir`; `prod.yml` keeps the files on the
`files-data` volume at `CENACLE_FILES_DIR` (`/data/files` in `prod.yml`; the server itself
has no default and refuses to start with `dir` but without an absolute directory). Every
chat server must mount the same one (on several hosts: shared storage). With both,
browsers upload to the chat server (`/api/uploads`, with a one-time ticket for the file's
key and size), which writes the file; garage and the `/<bucket>/` route are then not
needed. Keep the timeouts of a proxy in front long enough for the largest file.

Virus scanning: start the stack with `--profile clamav` and set
`CENACLE_CLAMAV_ADDR=clamav:3310`. ClamAV (GPL-2.0) runs as its own container, downloads
virus signatures from `database.clamav.net` on start and keeps them current. Its
`StreamMaxLength` must be at least `CENACLE_FILES_MAX_SIZE_MB`.

The image includes the signatures of its build date, so ClamAV also starts without internet
access, but they age (it warns after seven days). In air-gapped networks bring new ones in
regularly, in one of two ways:

- **Copy them.** On a connected machine:
  `docker run --rm -v $PWD/clamav-db:/var/lib/clamav clamav/clamav:1.5.4 freshclam --foreground --stdout`
  (about 110 MB). Move `clamav-db/` to the host, then
  `docker compose -f prod.yml --env-file .env.prod cp ./clamav-db/. clamav:/var/lib/clamav/`
  and `docker compose -f prod.yml --env-file .env.prod exec clamav clamdscan --reload`.
- **A local mirror.** Serve the `.cvd` and `.cvd.sign` files from a web server inside the
  network and give the `clamav` service `FRESHCLAM_CONF_PrivateMirror=http://<mirror>` and
  `FRESHCLAM_CONF_ScriptedUpdates=no`; it then updates from there.

`CLAMAV_NO_FRESHCLAMD=true` stops the update attempts altogether.

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

| Setting                          | Default               | Meaning                                                                                                                                                                       |
| -------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CENACLE_LINK_PREVIEWS`          | `true`                | The server fetches public pages linked in messages for previews; `false` without internet access.                                                                             |
| `CENACLE_DATABASE_MAX_CONNS`     | `25`                  | Database connections per chat server ([performance](../operations/performance.md)).                                                                                           |
| `CENACLE_DRAIN_DELAY`            | `5s` in `prod.yml`    | A stopping chat server keeps serving this long while the proxy moves away (upgrades without errors). The server's own default is none (shutdown starts at once); Helm: `10s`. |
| `CENACLE_SESSION_IDLE_TIMEOUT`   | `none`                | A signed-in device ends after this long unused (`none`: never; people stay signed in until they sign out).                                                                    |
| `CENACLE_SESSION_MAX_AGE`        | `none`                | ... and after this long at the latest (`none`: no maximum).                                                                                                                   |
| `CENACLE_AUDIT_RETENTION`        | `none`                | The chat server's audit log is deleted after this long (for example `8760h`); `none` keeps it. Events an audit stream has not sent yet stay.                                  |
| `CENACLE_AI_REQUEST_RETENTION`   | `none`                | Records of AI requests (kind and size) are deleted after this long; `none` keeps them.                                                                                        |
| `CENACLE_LINK_PREVIEW_RETENTION` | `none`                | Link previews (and their pictures) are deleted after this long; messages then show the bare link. `none` keeps them.                                                          |
| `CENACLE_WEB_APP`                | unset                 | `on` or `off` overrides the administrators' web app setting (recovery); unset leaves it to them.                                                                              |
| `CENACLE_DESKTOP_MIN_VERSION`    | unset                 | The oldest desktop app accepted (for example `0.30.0`); older apps ask to update first.                                                                                       |
| `CENACLE_PRIVACY_URL`            | unset                 | Your privacy policy for this server, linked from Settings → Account and from the desktop app's pairing page (see [privacy](../privacy.md)).                                   |
| `CENACLE_SOURCE_URL`             | Cenacle's repository  | The source code of this server, linked from Settings → Account. AGPL-3.0 asks a changed Cenacle offered over a network to offer its changed source: point this at it.         |
| `CENACLE_LOG_LEVEL`              | `info`                | `debug`, `info`, `warn` or `error` (`IDP_LOG_LEVEL` for Cenacle ID).                                                                                                          |
| `CENACLE_AI_URL`, `_MODEL`       | (none)                | Optional AI with a model you run; see the [AI guide](../operations/ai.md).                                                                                                    |
| `IDP_LOGIN_RATE_LIMIT`           | `10`                  | Sign-in attempts per address and minute; raise it when many people share one public address.                                                                                  |
| `IDP_PRIVACY_URL`                | `CENACLE_PRIVACY_URL` | The privacy policy linked at the foot of Cenacle ID's sign-in and account pages; unset: no link.                                                                              |
| `IDP_COOKIE_DOMAIN`              | (none)                | Share Cenacle ID's cookies across subdomains, e.g. `example.com`.                                                                                                             |

Cenacle ID keeps up to 10 database connections (`IDP_DATABASE_POOL_MAX`); keep the sum of
all chat servers' and Cenacle ID's connections below PostgreSQL's `max_connections`.

The chat server's root file system is read-only; archive exports and imports are staged
in `/tmp`, a memory file system of `CENACLE_TMP_SIZE` (default `1g`, counted against the
server's memory). For exports or imports larger than that, raise it, or mount a volume at
`/tmp` in a compose override (or point `TMPDIR` at a mounted volume).

### First account and Cenacle ID operations

Cenacle ID has no self-registration yet. Create accounts with its CLI; create the
administrator's account with the address in `CENACLE_ADMIN_EMAIL` and `--verified`, and add
`--admin` to make it a Cenacle ID administrator as well (the administration at
`https://<id-domain>/account/admin`, where the sign-in policy, directories and identity
providers are set; `CENACLE_ADMIN_EMAIL` only makes it the chat's administrator). It asks
for the password twice, without showing it (a password never goes on the command line):

```sh
docker compose -f prod.yml --env-file .env.prod run --rm idp \
  node dist/cli.js users create --email you@example.com --name "Your Name" --verified --admin
```

An existing account becomes a Cenacle ID administrator with `users admin --email <e>` (and
stops being one with `users no-admin --email <e>`), run the same way. `node dist/cli.js`
without a command prints every command.

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

From the host (the chat server unless another container is named). The third column says
what makes Cenacle use a destination and, in brackets, whether that is the default.

| Destination                                     | Port                                                                    | Used when (default)                                                                                                                         | Turned off by                                                                                             |
| ----------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| DNS                                             | 53/udp, 53/tcp                                                          | always                                                                                                                                      | –                                                                                                         |
| Let's Encrypt (Caddy)                           | 443/tcp                                                                 | certificate issuance and renewal, `CENACLE_TLS_MODE=acme` (on)                                                                              | `CENACLE_TLS_MODE=files` or `internal`                                                                    |
| Container registry (`ghcr.io`)                  | 443/tcp                                                                 | installing and upgrading images (not needed air-gapped)                                                                                     | moving images with `docker save` / `docker load`                                                          |
| SMTP relay                                      | `CENACLE_SMTP_PORT` (587; 465 is usual with `tls`)                      | e-mail about missed messages, `CENACLE_SMTP_HOST` set (off)                                                                                 | empty `CENACLE_SMTP_HOST`                                                                                 |
| Public web sites (link previews)                | 443/tcp, https only                                                     | pages linked in messages and the image they name (`og:image`, `twitter:image`), up to 3 redirects, each checked (on)                        | `CENACLE_LINK_PREVIEWS=false`                                                                             |
| RSS and Atom feeds                              | 443/tcp, https                                                          | a channel manager ran `/feed subscribe <address>` (none); each feed is read every 15 minutes, less often after failures                     | `/feed unsubscribe <address>`                                                                             |
| Bots' and workflows' servers                    | 443/tcp, https                                                          | slash commands, event deliveries, workflow webhooks a workspace adds (none)                                                                 | removing them                                                                                             |
| SIEM, HTTPS endpoint                            | the URL's port (443), https                                             | System console → Audit log → Stream to a SIEM, _HTTPS endpoint_ (Off)                                                                       | _Off_ there                                                                                               |
| SIEM, syslog receiver                           | the `host:port` entered, TCP (TLS if chosen)                            | the same, _Syslog (RFC 5424 over TCP)_ (Off)                                                                                                | _Off_ there                                                                                               |
| Other Cenacle servers                           | 443/tcp                                                                 | only with federation (shared channels)                                                                                                      | System console → Federation                                                                               |
| Your AI model server                            | the port of `CENACLE_AI_URL`                                            | only with AI, `CENACLE_AI_URL` set (off)                                                                                                    | empty `CENACLE_AI_URL`                                                                                    |
| Browser push services                           | 443/tcp                                                                 | only with web push, `CENACLE_WEB_PUSH=true` (off)                                                                                           | `CENACLE_WEB_PUSH=false`                                                                                  |
| An external S3 service                          | the port of `CENACLE_S3_ENDPOINT`                                       | `CENACLE_S3_ENDPOINT` outside the host (default: the bundled Garage, inside the compose network)                                            | pointing it back at Garage, or another backend                                                            |
| Azure Blob Storage                              | 443/tcp (`<account>.blob.core.windows.net` or `CENACLE_AZURE_ENDPOINT`) | `CENACLE_FILES_BACKEND=azure` (off)                                                                                                         | another backend                                                                                           |
| OpenTelemetry trace collector                   | the port of `OTEL_EXPORTER_OTLP_ENDPOINT` (HTTP)                        | `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` set (unset in `prod.yml`; `observability.yml` sends to its own Tempo) | leaving both unset                                                                                        |
| WAL-G backup bucket (`postgres`, `walg-backup`) | the port of `AWS_ENDPOINT` in `secrets/walg.env`                        | only with `backup.yml` ([backup guide](../backup/README.md))                                                                                | not using `backup.yml`                                                                                    |
| ClamAV signatures (`clamav`)                    | 443/tcp to `database.clamav.net`; DNS TXT `current.cvd.clamav.net`      | only with the optional virus scanner (`clamav` profile), at every update check                                                              | a local mirror (`FRESHCLAM_CONF_PrivateMirror`), `CLAMAV_NO_FRESHCLAMD=true`, or not starting the profile |
| LDAP / Active Directory (`idp`)                 | 389 or 636/tcp (3268/3269 for a Global Catalog)                         | directory sign-in, once a directory is connected (none)                                                                                     | turning the directory off                                                                                 |
| Identity providers (`idp`)                      | 443/tcp                                                                 | sign-in with OpenID Connect or SAML providers, once one is added (none)                                                                     | turning the provider off                                                                                  |

The chat server's requests made for people, bots and channels (link previews, feeds, bots
and workflows, federation, the SIEM stream, web push) go through its egress client, which
never uses a proxy: `HTTP_PROXY` and `HTTPS_PROXY` are ignored, so these destinations must
be reachable directly. It reaches private networks only when they are listed in
`CENACLE_EGRESS_ALLOW` (link previews and web push never), and only over https unless
`CENACLE_EGRESS_ALLOW_HTTP=true`. The S3, Azure and trace clients
are different: they follow `HTTPS_PROXY` and `NO_PROXY` when these are set.

From people's computers, the desktop app looks for updates at the server it is paired
with (`https://<domain>/downloads/desktop/`, 443/tcp), a minute after it starts and then
every six hours. It does not look when installed from the Microsoft Store or with the MSI,
or when the organization's policy sets `DisableUpdates`
([enterprise deployment](../desktop/enterprise-deployment.md)).

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
   `tls.key`; `internal` uses Caddy's internal CA, which clients must trust. Copy its root
   certificate out with
   `docker compose -f prod.yml --env-file .env.prod cp proxy:/data/caddy/pki/authorities/local/root.crt ./cenacle-root.crt`
   and install it on clients: Debian and Ubuntu
   `sudo cp cenacle-root.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates`
   (the name must end in `.crt`); Windows, as administrator,
   `certutil -addstore -f Root cenacle-root.crt`. The root is valid for ten years and stays
   while the `caddy-data` volume does; server certificates renew by themselves every 12
   hours. The message "failed to install root certificate" at Caddy's start is harmless. The
   internal certificates name no OCSP responder, so the proxy makes no outbound call for
   them. In air-gapped networks install from a bundle
   (see [offline installs](../operations/README.md#offline-air-gapped-installs)).
   `acme-ca` takes certificates from another ACME service, such as your organization's own
   (step-ca, a PKI with ACME): set `CENACLE_ACME_CA` to its directory URL and keep
   `ACME_EMAIL`. When the service's root certificate is not publicly trusted, put it in
   `deploy/compose/certs/acme-ca.pem` and set `CENACLE_ACME_CA_ROOT=file`. The service must
   reach the proxy on port 80 or 443 to validate, as Let's Encrypt does.
5. **Sharing a host:** if another reverse proxy already owns 80/443, either install Cenacle
   on a separate host or put it behind that proxy (forward both host names to Caddy on an
   internal port and remove the published ports from `prod.yml`).

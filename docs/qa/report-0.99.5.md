# QA report: 0.99.5

0.99.5 is the release candidate of 1.0 with voice and video calls. Its round followed the
[test plan](test-plan.md): the automated suites on the release commit, journeys of every role
on a real stack in both languages and themes, and the operations a new operator goes through
with the documentation only (install, upgrade with data, backup, restore and rollback).
2026-11-06.

## Result

No blocker is open. One blocker, eight major and eleven minor findings were fixed: 1–3 and
20 before the release was tagged, the others on `main` for 1.0. The access and supply chain
review (21–25) and what was tried the next day (26–31) added two major and nine minor
findings, all fixed. What was not tested here is listed at the end.

## Findings

| #   | Where          | What happened                                                                                                                                                                                 | Severity | Fixed in |
| --- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------- |
| 1   | Images         | zlib 1.3.2-r0 (CVE-2026-85091, published that day) in every image built on Alpine; the release pipeline's image scan stopped the release. The WAL-G image also had old Go modules and `gosu`. | major    | 4afb62a  |
| 2   | Calls          | A call that started while the page was still asking the server for it disappeared until the next check (up to 15 seconds) when the older answer arrived.                                      | major    | cbdbdb6  |
| 3   | Tests          | The new composer test expected voice and video clips where the browser cannot record (WebKit on Linux).                                                                                       | minor    | 4afb62a  |
| 4   | Rollback       | Restoring the pre-upgrade backup over the upgraded databases (`pg_restore --clean`, as documented) kept the tables of the new release; 0.99.4 started, but the next upgrade failed on them.   | blocker  | cfd90f9  |
| 5   | Upgrade guide  | Rolling back said to revert every migration; the 0.99.5 note said not to revert 00064, the newest, so none could be reverted. 0.99.4 runs on the 0.99.5 databases without reverting any.      | major    | cfd90f9  |
| 6   | Upgrade guide  | No command reverted Cenacle ID's migrations.                                                                                                                                                  | major    | cfd90f9  |
| 7   | Upgrade guide  | Rolling back kept the new `prod.yml`; the previous proxy image stayed unhealthy with it.                                                                                                      | major    | cfd90f9  |
| 8   | Upgrade guide  | The image registry moved (`CENACLE_IMAGE_PREFIX`) without a note; `pull` was refused.                                                                                                         | major    | cfd90f9  |
| 9   | Install guide  | The guide said the repository and the registry are public; before 1.0 they are not, and it did not say how to build the images instead.                                                       | major    | cfd90f9  |
| 10  | Backups        | `backup-daily.sh` did not copy uploaded files: a restore from it lost every attachment.                                                                                                       | major    | cfd90f9  |
| 11  | Backup guide   | The Garage example had no address that works (Garage is only inside the stack); restoring into a fresh stack left out unpacking the settings, starting PostgreSQL first and the files.        | minor    | cfd90f9  |
| 12  | Backup guide   | The manual backup wrote the dumps and the settings readable by everyone (default umask).                                                                                                      | minor    | cfd90f9  |
| 13  | Backup guide   | The cron and systemd examples named a path `install.sh` does not use.                                                                                                                         | minor    | cfd90f9  |
| 14  | Guides         | `docker compose ps` without `-f prod.yml --env-file .env.prod`; no word on naming the Compose project, so a second stack's backup could reach the first one's PostgreSQL.                     | minor    | cfd90f9  |
| 15  | install.sh     | Without curl it skipped the last check silently; it said the ports were "checked" just before stopping on them; its last line named the wrong section of the guide.                           | minor    | cfd90f9  |
| 16  | WAL-G guide    | The restore used `gosu`, which finding 1 removed from the image; found before the release of the change.                                                                                      | minor    | cfd90f9  |
| 17  | Interface      | A guest's workspace window had a General section with nothing in it when the workspace has no description.                                                                                    | minor    | acc34cf  |
| 18  | Interface      | A refusal (403, 404) was asked again twice, so a page someone may not see showed a loading box for seconds before saying so.                                                                  | minor    | acc34cf  |
| 19  | System console | "Active in 30 days" and each person's "Last seen" counted only people who had gone offline: on a new installation everyone online read as inactive.                                           | minor    | 634c8b5  |
| 20  | Tests          | The role journeys were not part of the whole-stack suite.                                                                                                                                     | minor    | 9df6155  |

## What was done

### Automated suites (release commit 4afb62a)

- `make lint`, `make test` (Go against PostgreSQL and Valkey, JS units), licenses, build and
  `make gen` without changes.
- Web journeys three times in a row (329 each), and Firefox and WebKit in the release
  pipeline (385); the call tests 20 times in a row.
- Whole stack (19, with the three new role journeys), with calls on (Pion media server,
  real audio and video), Cenacle ID's suite and the desktop app's (Linux, Xvfb).
- trivy (repository and images) and gitleaks; the release pipeline green on `main` and on
  the tag.

### Roles on a real stack

The chat server, Cenacle ID and the web app as processes against PostgreSQL and Valkey. Each
role signed in through Cenacle ID, opened every view, every menu of the app's frame, every
window those menus open and each of their sections, its settings and, for the administrator,
the system console, with a screenshot of each (about 230) and every console message, page
error and failed request written down.

| Role                                           | Language, theme             | What held                                                                                                                          |
| ---------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Instance administrator, owner of the workspace | English light, Turkish dark | Everything opens; the console's nine sections; no error but the 401 before signing in.                                             |
| Member                                         | English dark, Turkish light | No administration in menus; the console and other workspaces' settings refused (403) and said so (17, 18).                         |
| Member on a phone                              | English light               | Messages, threads, the "+" menu, the switcher.                                                                                     |
| Member promoted to admin and back              | English                     | Invitations appear and go again (whole-stack test).                                                                                |
| Guest through a guest link                     | English light               | Only the link's channel and its people; earlier messages shown; other channels and the administration refused; ends with the link. |
| Bot                                            | —                           | Jira webhook cards and slash commands (whole-stack tests).                                                                         |

Every screen was checked in English and Turkish ("siz" throughout), light and dark: no
missing translation, cut text or unreadable color was seen.

### Operations, with the documentation only

On this host in separate Compose projects (TLS mode `internal`, test host names), images
built from the release tags.

- A new installation by hand and with `install.sh` (in a container of its own, as port 80
  and 443 are taken here): every service healthy in 13 and 43 seconds; the first
  administrator, two-step verification at the first sign-in, a message and a file.
- 0.99.4 installed with its own guide and filled (two people, messages, a channel, files, a
  profile picture), then upgraded to 0.99.5: migrations 00059–00064 and Cenacle ID 0014–0015
  ran; both people stayed signed in; messages, files and the picture were all there.
- Backup and restore into a fresh stack: the same signing key, sessions still valid,
  single sign-on without a password, all data. After the fixes: restoring into emptied
  databases checked on a database with all 64 migrations; `backup-daily.sh` copied the
  Garage bucket, kept a file removed the next day under `files-removed/`, and wrote
  `files.tar` with `CENACLE_FILES_BACKEND=dir`.
- Rollback without reverting migrations (0.99.4 on the 0.99.5 databases) and with them
  (chat six times, Cenacle ID twice), then upgrading again: data intact. Restoring the backup
  over the upgraded databases failed as described (4).

## Access and supply chain review

After the round, the same day: who can change the code and its releases, what CI holds,
the dependencies, and whether the published images are the released source.

| #   | Where        | What was found                                                                                                                                                       | Severity | Fixed in |
| --- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------- |
| 21  | Images       | Rebuilt from the tag hours later, the web and Cenacle ID images differed from the published ones: the build's package update (1) took zlib 1.4, released in between. | major    | e7aaaf8  |
| 22  | GitLab       | 27 one-day access tokens made during the release, some with the `api` scope, were still active.                                                                      | minor    | revoked  |
| 23  | Dependencies | `klauspost/compress` 1.20.1 (GO-2026-6865); Cenacle's code does not reach it.                                                                                        | minor    | e7aaaf8  |
| 24  | GitHub       | The CLA check fails on Dependabot's pull requests of the mirror (bots do not sign off). Not a risk; the check now skips pull requests GitHub says Dependabot opened. | minor    | 413753d  |
| 25  | GitLab       | Job logs are visible to anyone who can see the project; harmless while it is private; turned off (2026-11-07).                                                       | minor    | setting  |

What held:

- **Images:** the server image rebuilt from `v0.99.5` matches the published one bit for bit;
  in the web and Cenacle ID images only the package layer differed (21), every layer of the
  application matched. After the fix two builds of web, Cenacle ID and the proxy came out
  identical, and trivy found nothing.
- **Dependencies:** OSV-Scanner over every lock file: no package known to be malicious
  (OpenSSF's `MAL-` records), two advisories, neither reached (govulncheck); `go mod verify`
  passes. npm packages must be a day old, keep their provenance and come from the registry;
  only electron and esbuild run install scripts. Packages were not read line by line.
- **GitLab:** one member (the owner); no project or deploy tokens, deploy keys or web hooks;
  `main`, `release-*` and `v*` protected, no force pushes; the six CI variables protected,
  secrets masked, signing keys as files. The runner takes only `cenacle` jobs, unprivileged,
  in a Docker engine of its own on its own network (8 CPUs, 14 GB); from there only ports 22,
  80 and 443 of the host are reachable.
- **GitHub:** the organization requires two-step verification, has one member and no outside
  collaborators, apps or invitations, and members cannot create or fork repositories; the
  nine repositories are private, with no deploy keys, hooks or secrets. The one workflow (the
  CLA check) runs on `pull_request` with read access, takes the check from the target branch
  and pins `actions/checkout` to the commit of its v7.0.1 tag.
- **Code:** no route outside the API description but health, WebSocket, metrics, the media
  service's signed callbacks and uploads with a single-use ticket; sessions and bot tokens found by hash
  only; the instance administrator only by an address Cenacle ID verified; every Cenacle ID
  administration page behind its administrator check; desktop updates only with the release
  key's signature; no command execution, `eval`, downloaded scripts, encoded blobs, date
  triggers or written-in credentials.

Not reviewable with the access here: the organization's web hooks and the account's SSH,
signing and GPG keys on GitHub (the CLI's token lacks those scopes).

## Tried after the round

What the round had left untested, tried the next day (2026-11-07) on this host.

| #   | Where    | What was found                                                                                                                                              | Severity | Fixed in |
| --- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------- |
| 26  | Upgrades | No guide for upgrading with Helm; the usual `helm upgrade --reuse-values` from 0.99.4 stopped on `calls.enabled`, which 0.99.5 added (nothing was changed). | major    | 20f73c8  |
| 27  | AI       | Requests set no token limit: a model that kept writing held the request until the timeout.                                                                  | minor    | 3c57f89  |
| 28  | AI       | Turning AI on or off for a workspace said nothing when it failed.                                                                                           | minor    | 3c57f89  |
| 29  | Offline  | The offline guide did not say to turn link previews off, which try to reach the internet.                                                                   | minor    | 20f73c8  |
| 30  | Mentions | `@name` typed without picking the suggestion, pasted, or sent by a bot is plain text: nobody is notified. Now resolved when sent or edited; not in code.    | minor    | cd4a82a  |
| 31  | TLS      | Only Let's Encrypt can issue certificates in `acme` mode; an organization's own ACME service cannot be named. New TLS mode `acme-ca`, tried against Pebble. | minor    | f3f7e70  |

What held:

- **AI with a model:** a local Ollama with a small model (qwen2.5 0.5B): the workspace's
  setting, the notice (which model, where, what is kept), a summary, a rewrite used in the
  draft and an answer with its source, each in 1 to 6 seconds; no error in the console.
  On a busy host the model slowed to two minutes and the app said so with its request ID.
- **Kubernetes:** the whole chart on k3s 1.35 with Traefik, by the guide: PostgreSQL,
  Valkey and Garage in the cluster, the Secret and `helm install` as written, the first
  administrator, sign-in in a browser through the ingress with two-step verification set up
  on the way, a message and a file through the bucket. Then 0.99.4 installed with its own
  chart and images, filled, upgraded (migrations 00059–00064 as hooks, pods replaced one by
  one) and rolled back with `helm rollback`: the same browser session stayed signed in and
  saw its messages and file each time.
- **Offline:** a bundle made with `bundle.sh` (7 images, 259 MB) against a registry on this
  host, loaded with `load.sh` in a Docker engine on a network with no way out; secrets from
  `gen-secrets.sh`, every service healthy, `/readyz`, the web app and Cenacle ID's discovery
  through the proxy, the first administrator; no connection attempt in any log.
- **WAL-G:** archiving to a Garage bucket of its own (5 segments, none failed), a base
  backup, rows written after it, then the guide's restore without `gosu` into a new volume:
  the replay brought the later rows back.
- **ACME:** the proxy in `acme` mode against Pebble (Let's Encrypt's test server), with the
  shipped Caddyfile plus Pebble's address: both names got certificates over TLS-ALPN, and
  the proxy served them.
- **A team's day:** three people on the real stack: a public and a private channel, joining
  from the directory, a mention, a thread reply, a reaction, a pin, saved items, an edit,
  a delete undone, a file shared and downloaded, search, a poll with two votes, a message
  sent later, a direct conversation, a custom status. All held, with no console or request
  error, except the mention written as plain text (30).

## Not tested here

- Real certificates from Let's Encrypt and ports 80 and 443 on this host (another service
  uses them); the same configuration was tried against Pebble.
- `docker pull` and `git clone` without credentials: nothing is published before 1.0.
- The desktop app's Windows installers (no Windows here), and an hour of use by a person new
  to Cenacle (a scripted team's day stood in for it).

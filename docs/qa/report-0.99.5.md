# QA report: 0.99.5

0.99.5 is the release candidate of 1.0 with voice and video calls. Its round followed the
[test plan](test-plan.md): the automated suites on the release commit, journeys of every role
on a real stack in both languages and themes, and the operations a new operator goes through
with the documentation only (install, upgrade with data, backup, restore and rollback).
2026-11-06.

## Result

No blocker is open. One blocker, eight major and eleven minor findings were fixed: 1–3 and
20 before the release was tagged, the others on `main` for 1.0. What was not
tested here is listed at the end.

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

## Not tested here

- Helm in this round (the chart's media service was run in k3d for this release with every
  `calls.exposure`); a real Kubernetes cluster.
- Real certificates from Let's Encrypt and ports 80 and 443 on this host (another service
  uses them).
- `docker pull` and `git clone` without credentials: nothing is published before 1.0.
- An air-gapped installation from a bundle, and the WAL-G drill end to end after the
  image change (its restore steps were run without `gosu`).
- AI with a model, the desktop app's Windows installers, and an hour of use by a person new
  to Cenacle.

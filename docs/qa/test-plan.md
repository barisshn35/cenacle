# Test plan of the release candidate

How a release candidate is tested before its release: what is checked, how, and what must
hold before the version is tagged. The results of each run are in a report next to this page
(latest: [report-0.99.5.md](report-0.99.5.md)).

## What must hold for the release

- No **blocker** (data loss, a security hole, a feature that cannot be used, an install or
  upgrade that fails) and no **major** finding (a feature that works only partly, an
  inaccessible journey, a wrong text a person acts on) is open.
- Every automated suite below passes on the release commit, and the release pipeline is green.
- Minor findings are fixed or listed in the report with the reason they wait.

## 1. Automated suites (every change, and the release commit)

| Suite                | What                                                                                      | Where                                               |
| -------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Unit and integration | server (Go, against PostgreSQL and Valkey), Cenacle ID, web, packages, SDKs               | `make test`                                         |
| Web journeys         | every feature with a mocked server: mouse (Chromium) and touch (phone), axe, target sizes | `make test-e2e`                                     |
| Other browsers       | the same journeys in Firefox and WebKit (Safari)                                          | `E2E_BROWSERS=all`, release tags                    |
| Whole stack          | the real server, Cenacle ID, directory and storage, signing in through to messages        | `make test-e2e-stack`                               |
| Cenacle ID           | sign-in, two-step verification, passkeys, administration                                  | `pnpm --filter @cenacle/idp test:e2e`               |
| Desktop app          | pairing, signing in, policies, start time and memory (Linux, Xvfb)                        | `pnpm --filter @cenacle/desktop test:e2e`           |
| Load, scale, soak    | throughput, years of data, a 20-minute run                                                | [performance](../operations/performance.md)         |
| Security             | dependency and image scans, secrets, fuzzing, the authorization matrix                    | CI `security`, [review](../security/review-0.42.md) |

## 2. Journeys, by role

Each journey in English and Turkish, light and dark, compact and comfortable, with a mouse and
with the keyboard only. Roles: instance administrator, workspace owner, admin, member, guest,
bot.

1. **Install:** a new installation from [docs/install](../install/README.md) only; the first
   administrator; Cenacle ID's sign-in with directory accounts and two-step verification.
2. **Workspace:** create, invite, roles and permissions, guests, guest links, welcome.
3. **Channels:** public, private, announcement, forum; categories; archive; move messages.
4. **Conversations:** direct and group messages, typing, presence, unread and mentions.
5. **Messages:** formatting, mentions, reactions, edit and history, delete, pin, save,
   reminders, scheduled messages, priority and acknowledgements, read receipts.
6. **Threads:** replies, following, the threads view, the activity view.
7. **Files:** upload, preview, lightbox, voice and video clips, limits, virus scanning.
8. **Search:** messages, files, people; filters; content search languages.
9. **Notifications:** sounds, quiet hours, muting, e-mail, web push, the notification policy.
10. **Encryption:** an encrypted channel (MLS), devices, recovery.
11. **AI** (with a model): the notice, accept and decline, summary, rewrite, ask.
12. **Automation:** bots, webhooks, slash commands, workflows, forms, the app platform.
13. **Collaboration:** channel tabs, canvases, lists, playbooks, polls, events.
14. **Administration:** the system console, policies, compliance (retention, legal hold,
    eDiscovery, export), audit log, federation, importers.
15. **Account:** profile, status, appearance, language, devices, data download, sign out.
16. **Desktop app:** install (setup, MSI, MSIX), pairing, policies, tray, deep links,
    updates, sign out, change server.

## 3. Operations

- Install with Compose and with Helm, following the documentation only.
- From 1.0, on a host with no stored credentials (no `docker login`, no Git credential
  helper): `git clone` of the public repository and `docker pull` of every image of the
  release (`server`, `idp`, `web`, `proxy` and their `CENACLE_IMAGE_VARIANT` builds, with the
  release tag) succeed without asking for a sign-in.
- Upgrade from the previous release with data; roll back; restore from backup.
- Air-gapped: images loaded from files, no outbound connections (link previews off).
- Backup and restore of PostgreSQL, the object store and Cenacle ID's signing keys.

## 4. Exploratory pass

A person uses the release candidate as a new team would for an hour, with screenshots of each
area, looking for what the suites do not catch: unclear texts, layout at odd sizes, slow
screens, dead ends, anything unfinished.

## Recording findings

Each finding: where, what happened, what was expected, severity (blocker, major, minor) and
the commit that fixed it. The report lists all of them.

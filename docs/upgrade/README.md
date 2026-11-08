# Upgrading Cenacle

Cenacle follows [Semantic Versioning](https://semver.org/). Every release is a git tag
(`vX.Y.Z`) with notes in [CHANGELOG.md](../../CHANGELOG.md). Until 1.0, minor releases may
contain breaking changes; they are always listed under "Upgrade notes".

## How database migrations run

- Migrations ship **inside the chat server binary**, so an image always carries exactly the
  migrations it expects.
- In `deploy/compose/prod.yml` the one-shot `migrate` service runs `server migrate up`
  before `server` starts (`service_completed_successfully`).
- Migrations take a PostgreSQL **advisory lock**: several replicas starting at once never
  apply a migration twice.
- `server migrate status` lists applied and pending migrations.

## Standard upgrade (compose)

1. Read the release notes for the target version (every version between yours and it).
2. **Back up** the databases and secrets ([backup guide](../backup/README.md)).
3. Take the new release's `deploy/compose/` files (for example `git fetch --tags && git
checkout v<version>` in your clone). Keep your own `.env.prod`, `secrets/` and `certs/`:
   they are not in the repository.
4. Compare `.env.prod` with the new `.env.prod.example` and add the settings that are new
   (their defaults are fine unless the release notes say otherwise); also compare the
   values of `CENACLE_IMAGE_PREFIX` and `CENACLE_VERSION`, which a release can change. Then run
   `./gen-secrets.sh`: it creates secrets a release added and keeps the ones you have.
5. Set `CENACLE_VERSION` in `.env.prod` to the new version.
6. `docker compose -f prod.yml --env-file .env.prod pull`
7. `docker compose -f prod.yml --env-file .env.prod up -d --remove-orphans` (migrations run
   first; see the release notes for long ones)
8. Check `docker compose -f prod.yml --env-file .env.prod ps`: all services, the proxy too, are healthy.
   `https://<chat-domain>/readyz` answers from the chat server (with several servers, from
   one of them; check a given one with
   `docker compose -f prod.yml --env-file .env.prod exec proxy wget -qO- http://server:8180/readyz`).

Air-gapped hosts: make a bundle with `deploy/airgap/bundle.sh` (add `--backup` with
`backup.yml`) on a connected machine, copy it over and run its `load.sh` before step 5. Both
machines need Docker's containerd image store (see offline installs in
[operations](../operations/README.md)).

## Standard upgrade (Helm)

1. Read the version notes below and **back up** the databases and the `cenacle` Secret
   ([backup guide](../backup/README.md)).
2. Take the new release's chart (`git checkout v<version>` in your clone) and upgrade with
   the values you installed with, best kept in a file:
   ```sh
   helm upgrade cenacle deploy/helm/cenacle -f my-values.yaml --wait
   ```
   Without such a file, `--reset-then-reuse-values` (Helm 3.14 or later) keeps the values you
   gave before and takes the new chart's defaults. Do not use `--reuse-values`: it keeps
   only the old release's values, so a setting a release adds has none and the upgrade stops
   with an error in a template (from 0.99.4 to 0.99.5: `calls.enabled`).
3. Migrations run as a Helm hook before the pods are replaced, one at a time. Check them
   with `kubectl exec deploy/cenacle-server -- /usr/local/bin/cenacle-server migrate status`.

To roll back, `helm rollback cenacle <revision>` (`helm history cenacle` lists them), with
the same rule for migrations as below: the version notes say whether the previous release
runs on the new database or which migrations to revert first.

## Rolling back

The version notes below say, for each release, whether the previous one runs on the new
database as it is (then no migration needs reverting) and which migrations can be reverted.

1. **From the backup** taken before the upgrade (when data changed, or a migration cannot be
   reverted): restore it into **empty** databases, never over the upgraded ones (`pg_restore
--clean` keeps the tables the new release added, and the next upgrade then fails on
   them):
   ```sh
   docker compose -f prod.yml --env-file .env.prod stop server idp proxy
   docker compose -f prod.yml --env-file .env.prod exec -T postgres psql -U postgres \
     -c 'DROP DATABASE cenacle_chat WITH (FORCE)' -c 'CREATE DATABASE cenacle_chat OWNER cenacle_chat' \
     -c 'REVOKE ALL ON DATABASE cenacle_chat FROM PUBLIC' \
     -c 'DROP DATABASE cenacle_idp WITH (FORCE)' -c 'CREATE DATABASE cenacle_idp OWNER cenacle_idp' \
     -c 'REVOKE ALL ON DATABASE cenacle_idp FROM PUBLIC'
   docker compose -f prod.yml --env-file .env.prod exec -T postgres \
     pg_restore -U postgres --exit-on-error -d cenacle_chat < cenacle_chat.dump
   docker compose -f prod.yml --env-file .env.prod exec -T postgres \
     pg_restore -U postgres --exit-on-error -d cenacle_idp < cenacle_idp.dump
   ```
   Then continue with step 3.
2. **Reverting migrations** the version notes call reversible, with the **new** images and
   before switching versions, once per migration:
   - chat: `docker compose -f prod.yml --env-file .env.prod run --rm migrate migrate down`
   - Cenacle ID: `docker compose -f prod.yml --env-file .env.prod run --rm idp-migrate node dist/cli.js migrate down`
3. Take the previous release's `deploy/compose/` files (`git checkout v<previous>`: its
   `prod.yml` goes with its proxy image), set the previous `CENACLE_VERSION` and
   `CENACLE_IMAGE_PREFIX`, and `up -d --remove-orphans`.

Destructive migrations (dropping data) are never reversible; restore from the backup
instead.

## Tested upgrade path

Before 0.28.0 a production stack was installed with 0.20.0 and filled with channels,
messages, a thread, reactions, a pin and a file. Then it was taken through every step of
this guide: upgraded to 0.27.1 (migrations 00021–00025), rolled back with `migrate down`
five times and started on 0.20.0 again, restored from `pg_dump` backups, and upgraded with
the 0.28 `prod.yml`. Every time, sessions stayed signed in and all data, the file
included, was there.

Before 0.99.0 the same was done from 0.43.0: installed from this documentation, filled,
upgraded to 0.99.0 (migration 00047), rolled back, restored from dumps and upgraded again
([QA report](../qa/report-0.99.md)).

Before 0.99.5's release, a Helm installation of 0.99.4 (k3s 1.35, Traefik) was filled, upgraded
with the 0.99.5 chart (`--reset-then-reuse-values`; migrations 00059–00064) and rolled back
with `helm rollback`: the browser stayed signed in, and messages and a file were there each
time ([QA report](../qa/report-0.99.5.md)).

Before 0.99.1, installations of 0.30.0, 0.35.0 and 0.40.0, each installed with its own
release's files and filled, were upgraded directly to 0.99.1 with the steps above: the
sessions stayed signed in and history, thread, pin, reaction and file were all there. A 0.30
database with three million messages and a million mentions upgraded in 67 seconds, 34 of
them migrations (00046 took 29) ([QA report](../qa/report-0.99.1.md)).

## Version notes

### Next release (after 0.99.5)

- Migration 00065: calls are on in every workspace unless its administrators turn them
  off. Workspaces whose call settings nobody changed are turned on; those turned off on
  purpose stay off. Calls still need the installation's media service: `install.sh --calls`,
  or `calls.enabled` in Helm.
- Notifications are on for every message by default, with a message sound. People who
  saved their notification settings keep them, except the sound of other messages: saved
  as "none" (the old default), migration 00069 sets it to "drop". People who want it
  silent choose "No sound" again in Settings → Notifications → Sounds.
- Migration 00070 adds the installation's default notification sounds (System console →
  Notifications), set to what they were (chime, pop, drop, volume 70).
- Migration 00068 adds sticker packs and an index of the messages that are stickers
  (`messages_sticker_idx`, partial). Building it reads the messages table once and holds
  back writes to it meanwhile: on a large installation, plan the upgrade for a quiet time.

### 0.99.5

- Calls: migration 00064 adds the call tables and workspace call settings. Existing
  installations and every workspace stay without calls until they are turned on
  (`install.sh --calls`, `calls.enabled` in Helm, then Call settings in each workspace).
  The media service is one more image, `cenacle-media`, of the same version. Its two key
  pairs (admission and callbacks) are separate and are not rotated automatically. See
  [calls](../install/calls.md).
- **Images** are published at `ghcr.io/cenacle-tr/cenacle-` (`CENACLE_IMAGE_PREFIX` in the
  new `.env.prod.example`); 0.99.4's file named the project's own registry. Set the new
  prefix, or keep the registry or mirror you use, before `pull`.
- **Rolling back to 0.99.4** needs no `migrate down`: 0.99.4 runs on the 0.99.5 databases
  (tested). Turn calls off first and let active calls end. Reverting the migrations anyway
  is chat six times (00064 to 00059; 00064's Down deletes call records and settings, 00063's
  does nothing) and Cenacle ID twice (0015, 0014).
- Helm: `networkPolicy.ingressNamespaceSelector` has no default any more (it named the
  ingress-nginx namespace). With `networkPolicy.enabled`, set it to your controller's
  namespace, or the chart stops with a message (see
  [Kubernetes](../install/kubernetes.md)).
- New, optional: `CENACLE_AUDIT_RETENTION`, `CENACLE_AI_REQUEST_RETENTION` and
  `CENACLE_LINK_PREVIEW_RETENTION` (Helm: `server.auditRetention`, `aiRequestRetention`,
  `linkPreviewRetention`). Unset or `none` keeps everything, as before; no migration.
- Cenacle ID links your privacy policy at the foot of its pages: Compose and Helm pass
  `CENACLE_PRIVACY_URL` as `IDP_PRIVACY_URL` unless you set that apart. The desktop app
  shows the policy on its pairing page for a server it has not used before.
- Cenacle ID runs on Node.js 26 LTS. Nothing to do with the published images. If you
  build from source, use Node.js 26 (`.nvmrc`); `pnpm install` warns on Node.js 24.
- Helm: the Ingress sends `/healthz` and `/readyz` (and paths below them) of the chat domain
  to the chat server, no longer to the web container. A monitor that read the web
  container's `/readyz` now gets the server's answer: JSON, and 503 when a check fails. When
  no server pod is ready, the ingress controller answers instead (Traefik: 503 "no available
  server"; ingress-nginx: its own 503 page).
- The desktop app's files are on the release's page on GitHub Releases
  (`docs/install/desktop.md`, Offering it from your server).
- `install.sh` (new) is for new installations; an existing one upgrades as before
  ([Standard upgrade](#standard-upgrade-compose)). Run on an existing installation, it
  keeps `.env.prod` and the secrets and only starts what is not running.
- Chat migration `00059` (quick, with a Down migration): it replaces the search function
  `cenacle_search_query` so that a word with a hyphen or an apostrophe is found. The search
  indexes and the stored messages do not change, so nothing is rebuilt.
- Chat migration `00060` (with a Down migration) gives PostgreSQL statistics on the words of
  messages and file texts (`CREATE STATISTICS`, then `ANALYZE` of both tables) and turns off
  the pending list of the message search index (`fastupdate = off`). Nothing is rebuilt; the
  time is the two `ANALYZE`s. It runs outside a transaction, and every step can run again.
  Measured on 2026-11-03 (PostgreSQL 18.6, 2,000,000 messages and 200,000 files with text,
  50 new messages a second during the migration):
  - 12.4–13.3 seconds; no message waited longer than 4 ms.
  - Changing the index has to wait for the queries that use it. While a slow search of the
    old version was running (40 s), the migration waited until it ended (38 s in all), but
    it waits at most 200 ms at a time and then lets new messages through: none waited longer
    than 201 ms. (Without that, they waited 27 seconds.) After five minutes of waiting it
    stops with an error; run it again.
  - The Down migration took 10 ms.
  - Afterwards writing a message takes a little longer, as new messages go into the search
    index at once (1.72 ms instead of 1.55 ms on that database).
- Chat migration `00061` (quick, with a Down migration) replaces the function
  `cenacle_search_vector` with the same one plus its cost (`COST 10000`) and a
  `SET search_path`, which keeps PostgreSQL from copying it into queries. Nothing is
  rebuilt. Measured on 2026-11-04 (PostgreSQL 18.6, 2,000,000 messages and 200,000 files of
  80 words): 7.8 ms; it takes no lock on a table (only a share lock on the schema), did not
  wait for a search using the function that was still running, and messages written during
  it took 9–14 ms. The Down migration puts the old function back.
- Searches stop after 10 seconds with the code `search_timeout` (HTTP 503). Clients of the
  API that retry every 503 should not retry this one.
- Chat migration `00062` (quick, with a Down migration) indexes the columns that point at a
  picture (profile pictures, workspace icons, link previews, emoji, stickers) and adds the
  uploaded fonts and sounds to what erasing a person removes. Chat migration `00063` then
  deletes the pictures nothing shows any more (older than an hour), such as those erased
  people left; its Down does nothing (the pictures are gone). Measured on 2026-11-04
  (PostgreSQL 18.6, 433,000 pictures, 200,000 people, 400,000 link previews, 20,000 pictures
  without a use): `00062` 0.28 s, `00063` 6.0 s (about 0.3 ms for each picture it deletes);
  people's profile changes and new link previews written during them waited at most
  245 ms. Without the indexes the clean-up had not finished after 5 minutes.
- Erasing a person now also hides the messages a legal hold keeps (they stay for
  eDiscovery and are purged once no hold keeps them) and sends `message.deleted` for every
  message to open apps, subscribed bots and shared servers. Bots subscribed to
  `message.deleted` get one delivery per message.
- Cenacle ID migration `0014` (quick: a new column) records when a person's sessions were
  ended, which the directory feed carries so the chat ends its own sessions made before
  then. Cenacle ID migration `0015_deleted_accounts` (quick; a new, empty table) keeps the
  id and time of accounts an administrator deletes, so the directory feed reports them to
  the chat. Reverting them (Rolling back, step 2) drops the column and the table: accounts
  deleted since then are no longer reported, so deactivate those people in the chat by hand
  if the chat had not read the feed yet.
- **Bots:** the SDKs no longer have `EditMessage`/`DeleteMessage` (Go) or
  `edit_message`/`delete_message` (Python). These calls never worked with a bot token (the
  server answers `403 bot_not_allowed`), so no running bot loses a working feature, but bots
  that reference them no longer build (Go) or fail with `AttributeError` (Python). Remove
  the calls; to change a card the bot posted, answer an interaction with `update` instead.
- `prod.yml` and the proxy image go together: use the `prod.yml` of the release (it sets the
  proxy's command and health check). `ACME_EMAIL` may now be empty with
  `CENACLE_TLS_MODE=internal` or `files`. Monitors that probed `https://<chat-domain>/healthz`
  or `/readyz` now get the chat server's answer (JSON; `/readyz` is `503` with a problem when
  a check fails) instead of the web container's.
- Offline (air-gapped) installs: make the bundle with `deploy/airgap/bundle.sh` (add
  `--backup` with `backup.yml`) and run its `load.sh` before starting; both machines need
  Docker's containerd image store ([offline installs](../operations/README.md)).
- Desktop app: nothing to do. It now comes with a Turkish dictionary; at the first start it
  replaces the Turkish one an older version downloaded from Google (`tr-TR-4-0.bdic` in its
  `Dictionaries` folder). It downloads nothing. On a system whose first language is not
  English or Turkish it no longer checks spelling.

### 0.99.4

- Nothing to do beyond changing the version: the application is the same as 0.99.3 and
  there are no migrations. Coming from an older release, follow the 0.99.3 notes below.

### 0.99.3

- Chat migration `00054` (quick): group mappings can be marked for review, and the chat keeps
  where it stands in Cenacle ID's group renames. Cenacle ID migrations `0011` and `0012`
  (small; rolling back runs their Down, which keeps renamed providers' new names).
- **Group mappings follow renamed groups** ([ADR 0046](../adr/0046-group-mappings-follow-renames.md)):
  the chat's directory sync moves workspace and channel mappings of a provider's group to its
  new name, before it applies the people the feed sends, and a sign-in does the same first.
  This covers the 0.99.2 prefix (`<provider>/<group>`) and every later provider rename. The
  manual step of the 0.99.2 notes is no longer needed:
  - from **0.99.1** straight to 0.99.3: mappings of provider groups by their bare name keep
    working; a bare name that is also a directory (LDAP) group's keeps meaning that group;
  - on **0.99.2**, mappings already made again with the prefix are unaffected: the bare ones
    were deleted (nothing to move) or, if kept, give way to the prefixed ones, which keep
    their role; bare ones never re-mapped come back, and their people get their memberships
    again when the feed sends them (Cenacle ID marks them changed, as in 0.99.2).
  - A bare name several providers had cannot be followed by itself: the mapping matches none
    of the groups and the workspace or channel group settings show it as **needs review**
    with the new names to choose from (or keep it as it is, or remove it). On 0.99.2 such
    mappings already gave no access; coming from 0.99.1, the memberships they gave are taken
    back until an administrator chooses (as in 0.99.2, but now listed).
  - Every moved, replaced or marked mapping is in the workspace's audit log.
  - Renames are followed only through the directory feed (`"directory_feed": true` for the
    chat's client, as Compose and Helm ship it). Without it, map renamed groups again by hand
    as in 0.99.2.
- Two identity providers may no longer give their groups the same prefix: `Corp/EU` and
  `Corp-EU` (both `Corp-EU/`) or names that differ only in case. Migration `0012` renames
  every provider but the oldest of such a set to `<name> (<id>)` and marks the mappings of its
  groups' old names for review; rename them as you like afterwards (the mappings follow).
- Tested: the rename rules by regression tests (Cenacle ID's migration from 0.99.1 data,
  provider renames, the chat following them); the new migrations rolled back and applied
  again.

- Chat migration `00055` (quick) records when a federated server's request signed only
  with `v1` was refused.
- Federation: a peer moved back below 0.99.2 after it signed with `v2` no longer has to be
  connected again. Its connection on the **Federation** page says that its
  requests are refused because it signs with an older version; once its admins confirm
  they moved it back on purpose, choose **Allow older signatures** (owners and admins,
  audited). Its held-up deliveries then go through as they are retried, and the connection
  requires `v2` again as soon as the peer signs with it after its next upgrade
  ([ADR 0047](../adr/0047-federation-older-signatures.md)). Our server's own requests
  always carry `v1` as well, so the downgraded peer keeps receiving them.

- **Security fixes** ([ADR 0048](../adr/0048-audit-fixes-0993.md)). Chat migrations
  `00056`–`00058` and Cenacle ID migration `0013` (all quick, with Down migrations):
  - `00056` records which message a queued bot or federation delivery copies, and deletes
    the stored deliveries of messages already deleted.
  - `00057` ties workflow runs, saved-message reminders and archive days to their messages.
  - `00058` keeps web push cursors per member and backs off failing push endpoints.
  - `0013` keeps an administrator's disable apart from the status a source sets. Disabled
    local accounts, and disabled provider accounts without SCIM, become
    administrator-disabled. Failed sign-in attempts are counted in a new table, so failures
    from before the upgrade no longer count towards the 15-minute window.
- Behaviour that changes for administrators:
  - Scheduled messages, workflow runs and reminders that the rules refuse when they are sent
    now **fail with a reason** instead of being posted. Workflow `dm` and `approval` steps
    whose people left the workspace fail too; update such workflows.
  - Federated messages, edits and reactions that the receiving channel's rules refuse are
    dropped on the receiving server.
  - AutoMod keyword and link rules may match more messages than before.
  - Resending a delivery of a bot that is disabled, or no longer in the channel or
    subscribed, answers `409 delivery_not_sendable`.
  - A paused federation connection now queues its events until it is resumed.
  - A daily archive file whose messages were removed is rewritten within about ten minutes;
    until then its download answers `409 archive_rewriting`.
  - Reactions, edits, pins, votes, acknowledgements, read positions and status changes
    have a per-user limit (5 times the message limit) and may answer `429`. Guest-link
    joins may answer `503` with `Retry-After` under heavy load.
  - Workspace admins who are not owners no longer see legal-hold, eDiscovery and archive
    export events in the workspace audit log, and only spillage reviewers see spillage
    events.
  - A name in `CENACLE_DEFAULT_CHANNELS` or `CENACLE_ANNOUNCEMENT_CHANNEL` that matches a
    private, access-ruled, encrypted or group-managed channel is no longer applied (a
    warning is logged at each start). Rename the channel or the setting.
  - If tracing was on (`OTEL_EXPORTER_OTLP_ENDPOINT`), rotate incoming-webhook,
    workflow-hook, invite and guest-link tokens that retained traces may hold, or purge the
    old traces.
  - Cenacle ID: saving a directory or provider whose server or issuer changed requires
    entering its password or secret again. Directory accounts have a **Disable** button,
    and `cenacle-idp users disable` also ends the account's sessions.
- Uploaded PDFs are read in a short-lived child process of the chat server (its own
  binary, limited in time and memory). A container that forbids a process from starting
  its own executable indexes no PDF text; a warning is logged at start.
- **Desktop app:** from 0.99.3 on, copy the `latest*.yml.sig` files to
  `downloads/desktop/` together with the update files. Apps install only updates signed
  with the release key built into them (`docs/operations/ci.md`). Organizations that build
  the app themselves put their own key in `desktop/src/update-keys.ts`.
- **Web:** after a session times out or is ended elsewhere, people unlock passphrase
  channels again and restore MLS history from their recovery key, as after Sign out.
  Browsers from before the upgrade keep what they hold until then.

### 0.99.2

- Chat migrations `00048`–`00053` (all quick):
  - `00048`/`00049` order federation deliveries per connection and record the signature
    version;
  - `00050` records which workspaces and channels an import created;
  - `00051` adds upload claims;
  - `00052` binds web push subscriptions to the session that made them and **removes the
    existing ones**: browsers that had push on subscribe again by themselves the next time
    the web app opens;
  - `00053` repairs guest roles: link guests and people from federated servers leave the
    default workspace (and its channels) unless they are guests there, every guest's role is
    set to guest, and directory guests leave the channels for everyone. Its Down changes
    nothing, as the removed rows were wrong.
- Guests stay guests everywhere: an invite, the default workspace or a directory change no
  longer makes them members or owners. A workspace whose only owner became a directory guest
  can be given a new owner by its admins.
- Channel access rules now apply to every way into a channel (group mappings, onboarding,
  the welcome channels, guest links, webhooks). Group mappings take back memberships the
  rules forbid; guest links of channels with rules stop working.
- Imports: an export that names an existing workspace, channel or conversation that no
  import created is refused; `server import --merge` joins people to them as plain members
  (no roles change). Workspaces imported before 0.99.2 count as existing, so importing into
  them again needs `--merge`.
- Federation: events of a connection reach the peer in order, a peer refusing one event
  holds up the rest of that connection (both sides show the error), and requests are signed
  for their connection and endpoint (`v2`) with replays refused. A peer moved back below
  0.99.2 after it signed with `v2` must be connected again (from 0.99.3, its admins can
  allow its older signatures instead; see 0.99.3).
- AutoMod's flag rules leave direct and group conversations alone, and reports of
  conversation messages reach only moderators taking part in them.
- CI (own runner): caches now live under `/cache/protected-true` and `/cache/protected-false`
  and tag builds use their own buildx builder; the old `/cache/*` directories and the
  `cenacle` builder can be removed ([CI](../operations/ci.md)).
- Tested path: 0.99.1 → 0.99.2 with data; the new migrations rolled back and applied again.
- Cenacle ID migrations `0009` and `0010` (small; rolling back runs their Down).
- **Groups of identity providers (OIDC, SAML, SCIM) reach the chat as
  `<provider>/<group>`** ([ADR 0045](../adr/0045-group-names-by-source.md)); directory
  (LDAP) groups keep their names. Before upgrading, note the workspace and channel group
  mappings that name a provider's groups; afterwards map them again with the prefix (the
  groups list in the settings shows the new names once people have signed in or the feed
  has run). Until then the memberships those mappings gave are taken back. Two providers
  may no longer have the same name: rename one before saving its settings.
- SCIM: pushed e-mail addresses are unverified unless the provider vouches for them (SAML
  "vouches for the e-mail addresses it sends", new OIDC setting "vouches for the e-mail
  addresses it provisions over SCIM"); turn that on for providers such as Entra ID or Okta
  whose addresses you trust. Addresses already stored keep their state until they change.
  Only vouched addresses link local accounts, and administrators and accounts with
  two-step verification are never linked by address (SCIM or sign-in).
- Cenacle ID: `IDP_TRUST_PROXY` is the number of proxies in front of it (or their addresses
  and CIDR ranges), no longer "trust every hop". `true` now means one proxy, what Compose
  (Caddy) and Helm (the ingress controller) have; Compose and Helm set `1`. With a load
  balancer that appends to `X-Forwarded-For` in front of the ingress controller, set Helm
  `idp.trustProxy` to `2`.

### 0.99.1

- No migrations; rolling back to 0.99.0 is changing the version.
- Settings → Account links the source code (AGPL-3.0 section 13). It is Cenacle's repository;
  if you run a changed Cenacle, point `CENACLE_SOURCE_URL` (Helm `server.sourceUrl`) at your
  changes.
- Images whose decoding would need more than the server's image memory (256 MB) get no
  preview, and are refused as profile pictures; they upload and download as before.
- Helm: replicas prefer different nodes, disruption budgets let unready pods be evicted, the
  migration jobs have resource limits, and pods no longer name an AppArmor profile. Review
  your values if you set `affinity` or the budgets yourself.
- Tested path: 0.30.0, 0.35.0 and 0.40.0 → 0.99.1 with data (see above).

### 0.99.0

- Migration: chat 00047 adds `ai_consents` (people's answers to the AI notice) and updates
  the function that erases a person. Quick; rolling back drops the table.
- With AI configured, people now accept a notice before their first AI request; until they
  do, the AI features ask first. Optional: `CENACLE_AI_POLICY_URL` (your page about the model
  server) and `CENACLE_PRIVACY_URL` (your privacy policy), in `.env.prod` or Helm
  `ai.policyUrl` and `server.privacyUrl`.
- Desktop app: the MSI and Microsoft Store installs do not update themselves; keep offering
  the setup and the update files for the others as before. Organizations can set the server
  by policy ([enterprise deployment](../desktop/enterprise-deployment.md)).
- Tested path: 0.43.0 → 0.99.0 with data, rolled back and restored ([QA report](../qa/report-0.99.md)).

### 0.43.0

- Migration: chat 00046 adds the channel to each mention and an index on it. It rewrites
  the mentions table once (about 30 seconds per million mentions, measured in the 0.99.1
  upgrade tests) and blocks writing mentions meanwhile: plan the upgrade outside working
  hours on large installations. Rolling back drops the column and the index.
- The server's database connections turn off PostgreSQL's JIT compilation (`jit=off`).
  Add `jit=on` to `CENACLE_DATABASE_URL` to keep it.

### 0.42.0

- No migration, nothing to do.

### 0.41.0

- Migrations: chat 00045 (validates a rule on messages without blocking writes; quick
  on installations that ran 00044 with 0.39 or 0.40), Cenacle ID 0008. Rolling back
  00044 archives channels encrypted with device keys.
- Signing out now removes the device's encryption keys: people who want their encrypted
  history on their next device make a recovery key first (Settings → Account).
- Directories no longer take over local Cenacle ID accounts with the same e-mail address
  unless their new setting "link by e-mail" is on; turn it on where that was relied on.
- Uploads to S3 land under `uploads/` and are copied to `files/` when complete: the
  object store's user needs to copy objects (any S3 service allows it to the bucket's
  owner).
- Compose: files were off since 0.38 unless `CENACLE_FILES_BACKEND` was set (`prod.yml`
  passed it empty). With an S3 endpoint they are on again; nothing to do.
- Compose: `CENACLE_SMTP_PASSWORD` and `CENACLE_AI_API_KEY` in `.env.prod` work again
  next to the empty `secrets/smtp_password` and `secrets/ai_api_key`.
- Compose: the chat server's `/tmp` is a memory file system of `CENACLE_TMP_SIZE`
  (default `1g`); raise it for large archive exports and imports.
- STIG profile together with `backup.yml`: add `stig-backup.yml` last (both files set
  PostgreSQL's command; until now only the last one applied).
- The images name their users by number (server 65532, Cenacle ID 1000, web and proxy
  10001; the ids are unchanged).
- Helm: pods set `runAsUser`, `runAsGroup` and `fsGroup`, which the kubelet needs to
  start them with `runAsNonRoot`. The server reads its required secrets as files; the
  Secret keeps the same keys. `files.backend: dir` now needs `files.dir.existingClaim`
  (it rendered S3 settings before). New values: `server.logLevel`,
  `server.sessionIdleTimeout`, `server.sessionMaxAge`, `server.webApp`,
  `server.desktopMinVersion`, `server.tmpSize`, `idp.logLevel`, `idp.databasePoolMax`,
  `idp.keyRetiredGraceSeconds`.

### 0.40.0

- No migration. To move to FIPS images, set `CENACLE_IMAGE_VARIANT=-fips` (Compose) or
  `image.fips: true` (Helm) and restart; Cenacle ID moves passwords to PBKDF2 as people
  sign in (directory and federated accounts are not affected).
- Helm: pods no longer mount a service account token.

### 0.39.0

- Migration: chat `00044_mls` (end-to-end encryption with device keys). Reversible:
  rolling back deletes messages of channels encrypted with device keys, and those
  channels stay encrypted and unreadable.
- Channels encrypted with a passphrase keep working; new encrypted channels use device
  keys.
- Proxies: requests to `/api/channels/…/e2e/commits` carry the group's state (up to a few
  hundred KB for large groups); keep request body limits above 2 MB.

### 0.38.0

- No migration. Existing installs keep S3 (an S3 endpoint means `CENACLE_FILES_BACKEND=s3`).
- Compose: run `deploy/compose/gen-secrets.sh` once more; it adds the empty
  `secrets/azure_key` that `prod.yml` now mounts (nothing else changes).
- To move files between stores, copy the objects (keys stay the same: `files/…`,
  `thumbs/…`) before switching `CENACLE_FILES_BACKEND`.

### 0.37.2

- No migration. Only the logo files and icons change; browsers may show the old favicon
  until their cache refreshes.

### 0.37.1

- No migration. People who chose German, French, Spanish or Arabic see English (the
  browser's choice falls back to it); they can choose Turkish in Settings → Language.

### 0.37.0

- Migration: chat `00043_content_search` (file text, search indexes on canvases and list
  rows). Reversible. Building the indexes takes a moment on large installations.
- After the upgrade the server reads the text of existing files in the background (needs
  the object store); search finds them by their text as it goes.
- Rolling back to 0.36, with the 0.37 images: once
  `docker compose -f prod.yml --env-file .env.prod run --rm migrate migrate down`; then the
  previous `CENACLE_VERSION`. The text read from files is dropped.

### 0.36.0

- Migrations: chat `00039_audit_stream`, `00040_privacy`, `00041_spillage` and
  `00042_archive_exports`. Reversible; nothing changes until someone turns on streaming or
  daily exports, erases a person or reports spillage.
- Audit streaming and daily archive exports run in the server's background jobs (every
  5 seconds and every 10 minutes); daily exports need the object store.
- Rolling back to 0.35, with the 0.36 images: four times
  `docker compose -f prod.yml --env-file .env.prod run --rm migrate migrate down`; then the
  previous `CENACLE_VERSION`. Erased people stay erased.

### 0.35.0

- Migrations: Cenacle ID `0007_scim` (SCIM tokens and the provider's ids of people and
  groups) and chat `00036_session_policy`, `00037_federation_controls` and
  `00038_guest_links`. All reversible; nothing changes until someone sets a policy, turns on
  SCIM or creates a guest link.
- The operator's `CENACLE_SESSION_IDLE_TIMEOUT` and `CENACLE_SESSION_MAX_AGE` stay the upper
  limits; the session policy in the system console can only shorten them.
- If the administration network policy locks every administrator out, clear it:
  `docker compose -f prod.yml --env-file .env.prod exec postgres psql -U postgres -d cenacle_chat -c "UPDATE instance_settings SET admin_networks = '{}'"`
  (the server reads it again within ten seconds).
- Rolling back to 0.34, with the 0.35 images: three times
  `docker compose -f prod.yml --env-file .env.prod run --rm migrate migrate down` and once
  `docker compose -f prod.yml --env-file .env.prod run --rm idp-migrate node dist/cli.js migrate down`;
  then the previous `CENACLE_VERSION`. Guests of guest links are deactivated; provisioned
  accounts stay.

### 0.34.0

- Migrations: chat `00034_admin` (adds `instance_settings.push_contents` and
  `email_contents`, both `full`) and `00035_permissions` (adds `workspaces.permissions`
  and `channels.moderation`, both empty: the 0.33 rules). Reversible.
- Nothing changes until someone changes a scheme, a channel's moderation or the
  notification policy.
- Rolling back to 0.33, with the 0.34 images: twice
  `docker compose -f prod.yml --env-file .env.prod run --rm migrate migrate down`; then the
  previous `CENACLE_VERSION`. Schemes, moderation and the policy are forgotten.

### 0.33.0

- Migrations: chat `00032_interactivity` (adds `bots.interactions_url`,
  `bots.interactions_secret` and `dialogs`) and `00033_integrations` (allows GitHub and
  e-mail webhooks, adds `channel_feeds`). Reversible.
- Feeds and interactions call out through the same network rules as bots: addresses inside
  your network need `CENACLE_EGRESS_ALLOW`.
- Rolling back to 0.32, with the 0.33 images: twice
  `docker compose -f prod.yml --env-file .env.prod run --rm migrate migrate down`; then the
  previous `CENACLE_VERSION`. GitHub and e-mail webhooks and feeds are removed.

### 0.32.0

- Migrations: chat `00030_message_priority` (adds `messages.priority`,
  `messages.ack_requested`, `messages.persistent`, `message_acks`, `message_reminders` and
  the workspace's reminder settings) and `00031_read_receipts` (adds
  `workspaces.read_receipts`, off, and `users.share_read_receipts`, on). Reversible.
- Read receipts stay off until owners or admins turn them on in the workspace settings.
- Reminders of urgent messages are allowed by default (every 5 minutes, up to 6 times);
  turn them off or change them in the workspace settings.
- Rolling back to 0.31, with the 0.32 images: twice
  `docker compose -f prod.yml --env-file .env.prod run --rm migrate migrate down`; then
  the previous `CENACLE_VERSION`. Priorities and acknowledgements are lost.

### 0.31.0

- Migrations: chat `00027_sidebar` (adds `sidebar_layouts`), `00028_mention_groups` (adds
  `mention_groups`, `mention_group_members`, the view `mention_group_people` and
  `workspaces.group_creation`, and allows group mentions) and `00029_message_edits` (adds
  `message_edits` and `workspaces.edit_history`). All reversible; nothing existing changes.
- Edits made from now on keep their earlier versions; edits made before keep none.
- Edit history is shown to the author only by default; owners and admins can show it to
  everyone in the workspace settings.
- Release images and files are signed from this version once the project's key is set up
  (`docs/operations/ci.md`); verify them with `deploy/cosign.pub`
  (`docs/security/README.md`).
- Rolling back to 0.30, with the 0.31 images: three times
  `docker compose -f prod.yml --env-file .env.prod run --rm migrate migrate down`; then
  the previous `CENACLE_VERSION`. Sidebars, groups and edit histories are lost.

### 0.30.0

- No migration.
- New, optional: the desktop app. To offer it, copy a release's files (package registry,
  `cenacle-desktop/0.30.0/`) into `deploy/compose/downloads/desktop/` — the new `prod.yml`
  mounts that folder into the web container — or set `web.downloadsClaim` with Helm. See
  [the desktop app](../install/desktop.md).
- `CENACLE_DESKTOP_MIN_VERSION` (unset by default) makes older desktop apps update first.

### 0.29.0

- Migrations: chat `00026_web_app` (one `instance_settings` row, reversible) and Cenacle ID
  `0006_sign_in_policy` (one `sign_in_policy` row, reversible). Both only add a table.
- **Two-step verification is now required.** Everyone without an authenticator app sets one
  up at their next sign-in (QR code, a code, ten recovery codes). To keep it optional, turn
  "Require two-step verification" off in Cenacle ID's administration, Sign-in, before people
  sign in again.
- **Passkeys are off.** Installations that use them turn "Allow passkeys" on in the same
  place; registered passkeys stay and work again once it is on.
- **Sessions last until sign-out.** `CENACLE_SESSION_IDLE_TIMEOUT` and
  `CENACLE_SESSION_MAX_AGE` default to `none`; set them (for example `168h` and `720h`) to
  keep the limits of 0.28.
- The web app can be turned off in Settings, Sign-in (server administrators). If the
  administrators lock themselves out, set `CENACLE_WEB_APP=on` and restart the server.
- Workspaces that never chose a font template now use Modern (Geist); those that chose
  Corporate keep Inter.
- Rolling back to 0.28, with the 0.29 images: once
  `docker compose -f prod.yml --env-file .env.prod run --rm migrate migrate down` and once
  `docker compose -f prod.yml --env-file .env.prod run --rm idp-migrate node dist/cli.js migrate down`;
  then the previous `CENACLE_VERSION`.

### 0.28.0

- No migration. Use `prod.yml` and the images of the same release: the 0.28 `prod.yml` with
  older images stops the server ("… and …_FILE are both set").
- Take the new `prod.yml` and run `./gen-secrets.sh` once more **before**
  `up`: it keeps every secret and adds the empty `secrets/smtp_password` and
  `secrets/ai_api_key` that `prod.yml` now mounts (compose stops with "secret file not
  found" otherwise).
- Images now come from the project's internal registry: set `CENACLE_IMAGE_PREFIX` to its
  `cenacle-` prefix in `.env.prod` (or remove the line). The proxy image is pulled as well; `up --build` still builds it.
- `CENACLE_S3_ENDPOINT` set but empty in `.env.prod` now turns files off; remove the line to
  keep the bundled Garage.

### 0.27.1

- A fix of the web app only (jumping to older messages on phones); no migration.

### 0.27.0

- No migration. Each chat server now keeps up to 25 database connections
  (`CENACLE_DATABASE_MAX_CONNS`). With several instances, keep their sum plus Cenacle ID's
  below PostgreSQL's `max_connections` (100 by default), or lower the setting.

### 0.26.0

- No migration. The proxy now sends `Strict-Transport-Security` (one year): serve the chat
  and Cenacle ID over https only. Rolling back to 0.25 needs no database step.

### 0.25.0

- Migration `00025_federation` adds connections to other servers, shared channels and their
  delivery queue. Nothing is shared until admins connect two servers.
- Servers that federate must reach each other: `https` on the public network, or private
  networks listed in `CENACLE_EGRESS_ALLOW`. The `/api/federation/v1/*` paths must be
  reachable through your proxy (they are under `/api`, as everything else).
- Rolling back to 0.24 needs `migrate down` once; connections and shares are removed, the
  messages exchanged stay.

### 0.24.0

- Migration `00024_ai` adds the workspace AI switch and a log of AI requests (no content).
- AI stays off. To offer it, run a model and set `CENACLE_AI_URL` and `CENACLE_AI_MODEL`
  (see the [AI guide](../operations/ai.md)); workspaces then turn it on in their settings.
- Rolling back to 0.23 needs `migrate down` once.

### 0.23.0

- Migration `00023_compliance` adds retention settings, legal holds, classifications,
  member attributes, channel access rules and encrypted channels. Nothing is deleted until
  an owner or admin sets a retention period.
- Messages deleted by retention are gone for good: place legal holds first where needed.
- Rolling back to 0.22 needs `migrate down` once; it deletes encrypted messages longer than
  4,000 characters, and holds, classifications and attributes.

### 0.22.0

- Migration `00022_collaboration` adds channel tabs, canvases, lists and their rows. Nothing
  to configure.
- Rolling back to 0.21 needs `migrate down` once; tabs, canvases and lists are removed with
  it.

### 0.21.0

- Migration `00021_automation` adds forms, form submissions, workflows, workflow runs and
  tasks, and two columns of messages (a task card, a form's answers). Nothing to configure.
- Workflows' requests to other servers use the same rules as bots: public `https`
  addresses, or private networks allowed in `CENACLE_EGRESS_ALLOW`.
- Rolling back to 0.20 needs `migrate down` once; workflows, forms and their messages are
  removed with it.

### 0.20.1

- Security update of Cenacle ID (Node.js 24.22.1, CVE-2026-111497). Update the `idp`
  image and restart it; nothing else changes. Use 0.20.1 instead of 0.20.0.
- Scanners that look at the Brotli version may still report 1.2.0: Node.js applied the
  fix to its bundled copy without changing the version number.

### 0.20.0

- Migration `00020_richer_communication` adds link previews, custom emoji, stickers and
  burn-on-read reveals, columns for forwarded, sticker and burn-on-read messages, voice
  and clip details of files, and the kind of each mention. Nothing to configure.
- Link previews are on by default. The server fetches pages from public addresses only
  (never through `CENACLE_EGRESS_ALLOW`); on servers without internet access set
  `CENACLE_LINK_PREVIEWS=false` (Helm: `linkPreviews: false`).
- Recording voice messages and clips needs the browser's microphone and camera, which
  browsers allow on HTTPS only.
- Rolling back to 0.19 needs `migrate down` once; custom emoji, stickers, previews and
  messages that were only a sticker are removed with it.
- `cenacle-idp` and `cenacle-web` 0.19.0 were not published (a registry push failure);
  upgrade from 0.18 straight to 0.20.

### 0.19.0

- Migration `00019_community_moderation` adds forum, poll, event, moderation, playbook,
  banner and terms tables and columns. Nothing to configure.
- Terms of service are off until an administrator publishes them (Settings →
  Announcements); from then on everyone accepts them before using the app or the API
  (bots excepted).
- Rolling back to 0.18 needs `migrate down` once; forum channels are removed with it.

### 0.18.0

- Migration `00018_threads_pins_saved` adds columns to `messages` (thread, pins) with
  indexes, and the tables for followed threads and saved messages. Nothing to configure.
- Rolling back to 0.17 needs `migrate down` once; replies then become ordinary messages of
  their channel.

### 0.17.0

- Migration `00017_search_notifications` creates the `unaccent` extension (trusted: the
  database owner may create it) and builds search indexes over all messages; on large
  databases the migration takes a while (roughly a minute per few million messages).
- E-mail: set `CENACLE_SMTP_*` (see `deploy/compose/.env.prod.example`, Helm `smtp`). Without
  it people simply cannot turn e-mail on.
- Web push stays off until `CENACLE_WEB_PUSH=true` and `CENACLE_WEB_PUSH_SUBJECT` are set;
  the server then needs outbound HTTPS to the browsers' push services.
- The web app adds a service worker (`/sw.js`, served without caching) and allows
  `media-src blob:` for uploaded sounds.

### 0.16.0

- Migration `00016_appearance` adds appearance settings, uploaded fonts and interface
  texts. Nothing to configure; people keep the look they had until they choose.

### 0.15.0

- Migration `00015_profiles` gives everyone a @username (directory accounts keep their
  sign-in name; names that differ only in case get a short suffix) and adds pictures,
  custom status, time zone and last seen.
- Directory photos reach the chat through the directory feed: nothing to configure; the
  first synchronization after the upgrade fetches them.

### 0.14.0

- Migrations: Cenacle ID `0003_directory`, `0004_passkeys`, `0005_federation`; chat
  `00014_directory_groups_guests`. They run on start as usual.
- **Update `deploy/compose/idp/clients.json`** (or the Helm values) for the chat client:
  `"scope": "openid email profile groups"` and `"directory_feed": true`. Without them the chat
  gets no groups and does not follow directory changes. Restart Cenacle ID afterwards.
- Cenacle ID e-mail addresses become optional (directory accounts may have none).
- Cenacle ID administrators: give the administration to an account with
  `node dist/cli.js users admin --email you@example.com` to reach `/account/admin`.
- The Cenacle ID pages allow `connect-src 'self'` (passkeys fetch their options).
- Rolling back to 0.13 needs the migrations rolled back first, with the 0.14 image, three
  times: `docker compose -f prod.yml --env-file .env.prod run --rm idp-migrate node
dist/cli.js migrate down` (accounts of identity providers become local accounts).

### 0.13.0

- No migration. The proxy image changes (load balancing across server instances): pull or
  rebuild it with the others.
- `CENACLE_DRAIN_DELAY` (5 s in `prod.yml`) delays shutdown; the server gets 30 s to stop
  (`stop_grace_period`).
- Run `./gen-secrets.sh` again before using `observability.yml` or `backup.yml` (it adds their
  secrets and keeps the others).

### 0.12.0

- Run `./gen-secrets.sh` again before upgrading: it keeps every existing secret and adds the
  object store's (`s3_access_key`, `s3_secret_key`, `garage_rpc_secret`, `garage.env`).
- New services: `garage` (files) and its one-shot `garage-volume`; optional `clamav`
  (`--profile clamav`). The proxy image changes (uploads to `/cenacle-files/`): pull or
  rebuild it with the others.
- Chat migration `00013_files` adds files and lets messages consist of files only.
  Reversible (`migrate down` drops file records and messages that had only files; the
  bucket's objects stay until removed).
- Back up the bucket from now on ([backup guide](../backup/README.md#object-store-files)).

### 0.11.0

- Chat migration `00012_commands_subscriptions_scheduling` adds slash commands, event
  subscriptions and their deliveries, scheduled messages, and the per-workspace system bot.
  Reversible (`migrate down` drops them; reminders already sent stay as messages).
- Bots are reached only on the internet by default. If a bot runs in a private network,
  list that network in `CENACLE_EGRESS_ALLOW` (e.g. `10.20.0.0/16`); the server container
  needs a route to it.

### 0.10.1

- Security and reliability fixes; no migration and nothing to change.

### 0.10.0

- Chat migration `00011_bots_and_webhooks` adds bot accounts, bot tokens and incoming
  webhooks. Reversible (`migrate down` drops them; bot accounts that posted messages stay
  as ordinary accounts).
- Webhook addresses use `CENACLE_PUBLIC_URL`; systems that post to them (Jira Data Center,
  monitoring) must reach that address.

### 0.9.0

- Chat migration `00010_outbox_reactions_mentions` adds the event outbox, reactions,
  mentions and message attachments, and lets messages with cards have no text. Reversible
  (`migrate down` drops reactions, mentions and cards, and deletes messages without text).
- `server migrate up` now also applies River's migrations (its `river_*` tables in the chat
  database). `migrate down` does not remove them; drop them by hand if you go back further
  than 0.9 (`river migrate-down` from River's CLI, or `DROP TABLE river_*`).
- The `migrate` service in `prod.yml` runs before the server as before; nothing to change.

### 0.8.0

- Cenacle ID migration `0002_mfa_and_audit` adds two-step verification and the account
  audit log; chat migration `00009_sessions_and_audit` adds the session's Cenacle ID `sid`
  and the workspace audit log. Both are reversible (`migrate down` drops the second
  factors, recovery codes and audit logs).
- Add the back-channel address to the chat client in `deploy/compose/idp/clients.json`
  (the file in the repository has it):
  `"backchannel_logout_uri": "http://server:8180/api/auth/backchannel-logout"`. Sessions
  created before the upgrade carry no `sid`; they end with Cenacle ID logouts only by
  their idle and absolute timeouts.
- Users find two-step verification in the app under Settings → Open Cenacle ID, or at
  `https://<id-domain>/account`.

### 0.7.0

- Chat migration `00008_direct_messages_and_unread` allows direct and group conversations
  and adds read positions; every existing member starts with everything read (no flood of
  unread messages). Reversible (`migrate down` deletes conversations and read positions).
- Presence and typing use Valkey pub/sub (`cenacle:ephemeral`) and keys under
  `cenacle:presence:`; nothing to configure.

### 0.6.0

- Chat migration `00007_workspaces` creates the default workspace ("Cenacle") and moves
  every channel, category and user into it; the current administrator becomes its owner.
  Reversible while only the default workspace exists (`migrate down` drops workspaces,
  roles and invitations; channels of other workspaces would be lost).
- `CENACLE_ADMIN_EMAIL` now names the instance administrator (creates workspaces, owns the
  default one). Nothing to change.
- Optional: `IDP_LOGIN_RATE_LIMIT` (default 10) for Cenacle ID in `.env.prod`.

### 0.5.0

- Chat migration `00006_channel_and_message_management` adds edit and delete times to
  messages, channel archiving and categories. Reversible (`migrate down` removes
  categories and the edit marks).

### 0.4.0

- Chat migration `00003_channels_messages` adds `channels` (with `#general`) and
  `messages`. It is reversible (`migrate down` drops both tables and all messages).
- Chat migration `00004_channel_membership` adds channel membership (every existing user
  joins the default channels), the announcement and default flags and the administrator
  flag; `general` becomes `General`. Reversible.
- Chat migration `00005_private_channels` adds channel visibility (all existing channels
  stay public) and member roles (creators become managers). Reversible.
- New settings in `.env.prod` (see [installation](../install/README.md#administrator-and-default-channels)):
  `CENACLE_ADMIN_EMAIL` (without it nobody can create channels),
  `CENACLE_ANNOUNCEMENT_CHANNEL` (default `Central`), `CENACLE_DEFAULT_CHANNELS` (default
  `General`). Use the new `prod.yml`, which passes them to the server.
- WebSocket connections go through Caddy's `/ws` route, which the stack has had since
  0.1.0; nothing to change in `prod.yml`.
- Valkey now carries the live event stream (`cenacle:events`). It is not needed for
  backups: clients reload what they missed.

### 0.3.0

- Use the new `prod.yml`: the chat server gets its public URL, Cenacle ID's issuer and the
  `chat_client_secret` secret (created by `gen-secrets.sh` since 0.2.0). No new secrets.
- Chat migration `00002_users_sessions` adds `users` and `sessions`. It is reversible
  (`migrate down` drops both tables, signing everyone out).
- Optional settings: `CENACLE_SESSION_IDLE_TIMEOUT` (default `168h`) and
  `CENACLE_SESSION_MAX_AGE` (default `720h`).

### 0.2.0

- New Cenacle ID secrets: run `./gen-secrets.sh` again (existing secrets are kept, new ones
  are added) and use the new `prod.yml`, which adds the `idp-migrate` step and mounts
  `idp/clients.json`.
- The IdP database gets its first migration (`idp_migrations` table); it runs automatically.
- Create the first account with `node dist/cli.js users create` in the `idp` container (see the
  [installation guide](../install/README.md)).

### 0.1.1

No database migrations. Set `CENACLE_VERSION=0.1.1` and, if you do not use Let's Encrypt,
`CENACLE_TLS_MODE` (see the [installation guide](../install/README.md)).

### 0.1.0

Baseline release: one empty migration (`00001_init`) establishes the migration history.
Nothing to upgrade from.

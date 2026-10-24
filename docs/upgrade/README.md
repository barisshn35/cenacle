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

1. Read the release notes for the target version.
2. **Back up** the databases and secrets ([backup guide](../backup/README.md)).
3. Set `CENACLE_VERSION` in `.env.prod` to the new version.
4. `docker compose -f prod.yml --env-file .env.prod pull`
5. `docker compose -f prod.yml --env-file .env.prod up -d`
6. Check `docker compose ps` (all healthy) and `https://<chat-domain>/readyz` from the host.

Air-gapped hosts: `docker save` the images on a connected machine, copy them over and
`docker load` before step 5.

## Rolling back

1. Prefer restoring the backup taken before the upgrade when data changed.
2. If the new release only added migrations that are safe to revert, roll them back with the
   **new** image before switching versions:
   `docker compose -f prod.yml --env-file .env.prod run --rm migrate migrate down`
   (repeat once per migration to revert), then set the previous `CENACLE_VERSION` and
   `up -d`.
3. Release notes state whether a migration is reversible. Destructive migrations
   (dropping data) are never reversible; restore from backup instead.

## Tested upgrade path

Before 0.28.0 a production stack was installed with 0.20.0 and filled with channels,
messages, a thread, reactions, a pin and a file. Then it was taken through every step of
this guide: upgraded to 0.27.1 (migrations 00021–00025), rolled back with `migrate down`
five times and started on 0.20.0 again, restored from `pg_dump` backups, and upgraded with
the 0.28 `prod.yml`. Every time, sessions stayed signed in and all data, the file
included, was there.

## Version notes

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
- Images now come from `git.calaixo.com:5050/calaxio/cenacle`: set
  `CENACLE_IMAGE_PREFIX=git.calaixo.com:5050/calaxio/cenacle/cenacle-` in `.env.prod` (or
  remove the line). The proxy image is pulled as well; `up --build` still builds it.
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

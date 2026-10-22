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

## Version notes

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
- Rolling back to 0.13 needs the migrations rolled back first (`migrate down` in Cenacle ID
  three times; accounts of identity providers become local accounts).

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
- Create the first account with `cenacle-idp users create` (see the
  [installation guide](../install/README.md)).

### 0.1.1

No database migrations. Set `CENACLE_VERSION=0.1.1` and, if you do not use Let's Encrypt,
`CENACLE_TLS_MODE` (see the [installation guide](../install/README.md)).

### 0.1.0

Baseline release: one empty migration (`00001_init`) establishes the migration history.
Nothing to upgrade from.

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

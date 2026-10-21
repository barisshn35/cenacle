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

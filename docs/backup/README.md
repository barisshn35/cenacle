# Backup and restore

What to back up for a Cenacle installation, and how. Restore drills are part of operating
Cenacle: a backup that has never been restored is not a backup.

## What to back up

| Data                         | Where                                                         | Needed for                                   |
| ---------------------------- | ------------------------------------------------------------- | -------------------------------------------- |
| Chat database `cenacle_chat` | PostgreSQL                                                    | messages, channels, workspaces, sessions     |
| IdP database `cenacle_idp`   | PostgreSQL                                                    | accounts, MFA, clients, consents             |
| Secrets                      | `deploy/compose/secrets/`                                     | database passwords and URLs, Valkey password |
| Settings                     | `deploy/compose/.env.prod`                                    | domains, version                             |
| IdP signing keys             | IdP database, encrypted with `secrets/idp_key_encryption_key` | validating issued tokens across restores     |
| Object store (v0.12+)        | S3-compatible store (Garage by default)                       | uploaded files                               |
| TLS state                    | `caddy-data` volume                                           | optional; Caddy re-issues certificates       |

Valkey holds only ephemeral data (presence, typing, short-lived tickets, caches) and does
not need a backup.

Keep secrets and database backups **together and encrypted**. Token signing keys are stored
in the IdP database, encrypted with `secrets/idp_key_encryption_key`: a database restored
without that key cannot use its signing keys (Cenacle ID would need new keys, which
invalidates every issued token and session).

## Small installations: logical dumps

```sh
cd deploy/compose
ts=$(date +%Y%m%d-%H%M%S)
docker compose -f prod.yml --env-file .env.prod exec -T postgres \
  pg_dump -U postgres -Fc cenacle_chat > "backup-chat-$ts.dump"
docker compose -f prod.yml --env-file .env.prod exec -T postgres \
  pg_dump -U postgres -Fc cenacle_idp > "backup-idp-$ts.dump"
tar -czf "backup-secrets-$ts.tgz" secrets .env.prod
```

Restore into a fresh stack (services stopped except `postgres`):

```sh
docker compose -f prod.yml --env-file .env.prod exec -T postgres \
  pg_restore -U postgres --clean --if-exists -d cenacle_chat < backup-chat-<ts>.dump
docker compose -f prod.yml --env-file .env.prod exec -T postgres \
  pg_restore -U postgres --clean --if-exists -d cenacle_idp < backup-idp-<ts>.dump
```

## Larger installations: continuous archiving (v0.13)

Point-in-time recovery with **pgBackRest** or **WAL-G** (base backups plus WAL archiving to
an S3-compatible bucket) will be documented and shipped as an optional compose profile and
Helm values in v0.13.

## Object store (v0.12)

Uploaded files live in an S3-compatible bucket behind an abstraction. Back up the bucket
with the store's own tooling (e.g. Garage bucket snapshots or `rclone sync` to a second
location) at the same frequency as the database, since messages reference file keys.

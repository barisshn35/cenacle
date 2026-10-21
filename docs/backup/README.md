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

## Object store (files)

Uploaded files live in an S3-compatible bucket (`cenacle-files`): `files/<id>` holds each
file and `thumbs/<id>` its image preview. The database says which files exist; the bucket
holds the bytes. Back both up at the same time, database first: a file missing from the
bucket shows as "The file is gone", while bytes without a database row are removed by the
server's hourly clean-up.

With the bundled Garage, copy the bucket over S3 with any S3 tool, for example `rclone`
(MIT) with the key from `secrets/s3_access_key` and `secrets/s3_secret_key`:

```sh
# ~/.config/rclone/rclone.conf
# [cenacle]
# type = s3
# provider = Other
# endpoint = http://<garage address>:3900   (on the "files" network, or published for the job)
# region = garage
# access_key_id = …
# secret_access_key = …
rclone sync cenacle:cenacle-files /backup/cenacle-files-$(date +%Y%m%d)
```

Restore copies the objects back (`rclone sync /backup/… cenacle:cenacle-files`). Garage
also keeps snapshots of its own metadata every six hours (`metadata_auto_snapshot_interval`).
The `garage-data` volume can be backed up as a whole while Garage is stopped. With your own
S3 service, use its versioning or replication instead.

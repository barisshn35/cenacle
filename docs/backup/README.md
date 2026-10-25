# Backup and restore

What to back up for a Cenacle installation, and how. Restore drills are part of operating
Cenacle: a backup that has never been restored is not a backup.

## What to back up

| Data                         | Where                                                         | Needed for                                |
| ---------------------------- | ------------------------------------------------------------- | ----------------------------------------- |
| Chat database `cenacle_chat` | PostgreSQL                                                    | messages, channels, workspaces, sessions  |
| IdP database `cenacle_idp`   | PostgreSQL                                                    | accounts, MFA, clients, consents          |
| Secrets                      | `deploy/compose/secrets/`                                     | every password and key (see below)        |
| Settings                     | `deploy/compose/.env.prod`, `idp/clients.json`                | domains, version, registered applications |
| IdP signing keys             | IdP database, encrypted with `secrets/idp_key_encryption_key` | validating issued tokens across restores  |
| Object store                 | S3-compatible store (Garage by default)                       | uploaded files                            |
| TLS state                    | `caddy-data` volume, `certs/` (`CENACLE_TLS_MODE=files`)      | optional with Let's Encrypt (re-issued)   |

Valkey holds only ephemeral data (presence, typing, short-lived tickets, caches) and does
not need a backup.

`secrets/` holds the database and Valkey passwords, Cenacle ID's key-encryption and cookie
keys, the chat server's client secret, the object store's keys and cluster secret, and,
when used, the SMTP password, the AI key, WAL-G's and Grafana's settings. On Kubernetes,
back up the Secret named by `existingSecret` the same way.

The database dumps are secrets too: the chat database holds the secrets shared with
federated servers and the web push key (losing it means devices subscribe again); Cenacle
ID's database holds directory and identity-provider credentials, encrypted with
`idp_key_encryption_key`.

Not on the server, so not in any backup: the keys of encrypted channels. Channels encrypted
with device keys keep them on each device; people's history backups are on the server but
sealed with their recovery key (and the escrow key, when the organization requires it). A
passphrase of an older encrypted channel cannot be recovered. AI keeps
only its settings and a log without content in the chat database.

Keep secrets and database backups **together and encrypted**. Token signing keys are stored
in the IdP database, encrypted with `secrets/idp_key_encryption_key`: a database restored
without that key cannot use its signing keys (Cenacle ID would need new keys, which
invalidates every issued token and session), and directory sign-in and other identity
providers have to be set up again.

## Small installations: logical dumps

```sh
cd deploy/compose
ts=$(date +%Y%m%d-%H%M%S)
docker compose -f prod.yml --env-file .env.prod exec -T postgres \
  pg_dump -U postgres -Fc cenacle_chat > "backup-chat-$ts.dump"
docker compose -f prod.yml --env-file .env.prod exec -T postgres \
  pg_dump -U postgres -Fc cenacle_idp > "backup-idp-$ts.dump"
tar -czf "backup-secrets-$ts.tgz" secrets .env.prod idp/clients.json certs
```

Restore into a fresh stack (services stopped except `postgres`):

```sh
docker compose -f prod.yml --env-file .env.prod exec -T postgres \
  pg_restore -U postgres --clean --if-exists -d cenacle_chat < backup-chat-<ts>.dump
docker compose -f prod.yml --env-file .env.prod exec -T postgres \
  pg_restore -U postgres --clean --if-exists -d cenacle_idp < backup-idp-<ts>.dump
```

## Larger installations: continuous archiving (WAL-G)

`deploy/compose/backup.yml` adds point-in-time recovery with WAL-G (Apache-2.0): PostgreSQL
archives every WAL segment (at least once a minute, `archive_timeout`) and a `walg-backup`
service takes a base backup every day, keeping seven, in an S3 bucket. Use storage that is
not this host (another site, another provider).

```sh
cd deploy/compose
./gen-secrets.sh                              # adds secrets/walg-postgres.env
cp walg.env.example secrets/walg.env && chmod 600 secrets/walg.env   # bucket and key
docker compose -f prod.yml -f backup.yml --env-file .env.prod up -d --build
docker compose -f prod.yml -f backup.yml --env-file .env.prod logs walg-backup
```

The PostgreSQL image stays the same Alpine image, with WAL-G added; the data volume does
not change. Check archiving with
`psql -U postgres -c "SELECT archived_count, failed_count FROM pg_stat_archiver"`.

**Restore** (to a new, empty volume; stop the stack first):

```sh
docker volume create cenacle_postgres-restore
docker run --rm --env-file secrets/walg.env -v cenacle_postgres-restore:/var/lib/postgresql \
  --entrypoint sh cenacle-postgres-walg:$CENACLE_VERSION -c '
    D=/var/lib/postgresql/18/docker
    mkdir -p $D && chown -R postgres:postgres /var/lib/postgresql && chmod 700 $D
    gosu postgres wal-g backup-fetch $D LATEST
    gosu postgres touch $D/recovery.signal
    echo "restore_command = '\''/usr/local/bin/wal-g wal-fetch %f %p'\''" >> $D/postgresql.auto.conf'
```

Then use that volume as `postgres-data` and start PostgreSQL: it replays the archived WAL to
the last archived segment (add `recovery_target_time = '…'` to `postgresql.auto.conf` for a
point in time) and opens. This drill was run end to end for this release: a row written
after the base backup came back.

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

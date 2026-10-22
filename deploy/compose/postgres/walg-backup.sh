#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Takes a base backup now and then every WALG_BACKUP_INTERVAL seconds (default
# a day), keeping WALG_RETAIN_FULL full backups (default 7). WAL segments are
# archived continuously by PostgreSQL itself (archive_command).
set -eu
interval=${WALG_BACKUP_INTERVAL:-86400}
retain=${WALG_RETAIN_FULL:-7}
until pg_isready -q; do sleep 2; done
while :; do
  echo "base backup starting"
  wal-g backup-push "$PGDATA"
  wal-g delete retain FULL "$retain" --confirm
  echo "next base backup in ${interval}s"
  sleep "$interval"
done

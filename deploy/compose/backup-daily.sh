#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# A daily logical backup of a Compose installation (docs/backup/README.md): both
# databases, the secrets and the settings, in one folder per day. It keeps the
# last 7 days and, of Sundays, the last 4 weeks, and copies the whole set to
# another machine. Run it from cron or a systemd timer, next to prod.yml.
#
#   CENACLE_BACKUP_DIR     where the backups go (default /var/backups/cenacle)
#   CENACLE_BACKUP_REMOTE  an rsync destination off this machine, e.g.
#                          backup@vault:/srv/cenacle/ (empty: no copy, say so)
#   CENACLE_BACKUP_COMPOSE the compose command (default: prod.yml with .env.prod)
set -eu
cd "$(dirname "$0")"
dest=${CENACLE_BACKUP_DIR:-/var/backups/cenacle}
remote=${CENACLE_BACKUP_REMOTE:-}
compose=${CENACLE_BACKUP_COMPOSE:-docker compose -f prod.yml --env-file .env.prod}
day=$(date +%Y-%m-%d)
umask 077
mkdir -p "$dest/daily" "$dest/weekly"
dir="$dest/daily/$day"
work="$dir.part"
rm -rf "${work:?}"
mkdir "$work"

# Dumps are secrets too (docs/backup): the folder is for root only.
for db in cenacle_chat cenacle_idp; do
  $compose exec -T postgres pg_dump -U postgres -Fc "$db" > "$work/$db.dump"
done
settings=""
for f in secrets .env.prod idp/clients.json certs; do
  [ -e "$f" ] && settings="$settings $f"
done
# shellcheck disable=SC2086 # the list is split on purpose
tar -czf "$work/settings.tgz" $settings
(cd "$work" && sha256sum -- *.dump settings.tgz > SHA256SUMS)
rm -rf "${dir:?}"
mv "$work" "$dir"

# Sunday's backup is also the week's.
if [ "$(date +%u)" = 7 ]; then
  rm -rf "${dest:?}/weekly/$day"
  cp -a "$dir" "$dest/weekly/$day"
fi

# keep DIR N: removes all but the N newest backups (names sort by date).
keep() {
  n=0
  printf '%s\n' "$1"/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] | sort -r | while read -r old; do
    [ -d "$old" ] || continue
    n=$((n + 1))
    if [ "$n" -gt "$2" ]; then rm -rf "${old:?}"; fi
  done
}
keep "$dest/daily" 7
keep "$dest/weekly" 4

if [ -n "$remote" ]; then
  rsync -a --delete "$dest/" "$remote"
else
  echo "backup-daily: no CENACLE_BACKUP_REMOTE, the backups are on this machine only" >&2
fi
echo "backup-daily: $dir"

#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# A daily logical backup of a Compose installation (docs/backup/README.md): both
# databases, the secrets and the settings, in one folder per day, and the
# uploaded files. It keeps the last 7 days and, of Sundays, the last 4 weeks,
# and copies the whole set to another machine. Run it from cron or a systemd
# timer, next to prod.yml.
#
# Files: with the bundled Garage, files/ mirrors the bucket and files-removed/DAY
# keeps what left it that day (kept as long as the daily folders); with
# CENACLE_FILES_BACKEND=dir, each day's folder has files.tar. Azure and other S3
# services are not copied: use their versioning or replication.
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
rclone_image=rclone/rclone:1.75.0@sha256:b06aed988cf5967de7c25be5925240983981c757f4ed1ac9d2fa659d51d60548
# setting NAME: its value in .env.prod (empty when unset).
setting() { sed -n "s/^$1=//p" .env.prod 2>/dev/null | tail -n 1; }
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

# The uploaded files, after the databases: a file the dumps know is in the copy.
backend=$(setting CENACLE_FILES_BACKEND)
endpoint=$(setting CENACLE_S3_ENDPOINT)
case "$backend" in
  '' | s3)
    if [ -z "$endpoint" ] || [ "$endpoint" = http://garage:3900 ]; then
      garage=$($compose ps -q garage)
      [ -n "$garage" ] || { echo "backup-daily: Garage is not running, the files were not copied" >&2; exit 1; }
      bucket=$(setting CENACLE_S3_BUCKET)
      docker run --rm --network "container:$garage" -v "$dest:/backup" \
        -e RCLONE_CONFIG_G_TYPE=s3 -e RCLONE_CONFIG_G_PROVIDER=Other \
        -e RCLONE_CONFIG_G_ENDPOINT=http://127.0.0.1:3900 -e RCLONE_CONFIG_G_REGION=garage \
        -e RCLONE_CONFIG_G_ACCESS_KEY_ID="$(cat secrets/s3_access_key)" \
        -e RCLONE_CONFIG_G_SECRET_ACCESS_KEY="$(cat secrets/s3_secret_key)" \
        "$rclone_image" sync --quiet "g:${bucket:-cenacle-files}" /backup/files \
        --backup-dir "/backup/files-removed/$day"
    else
      echo "backup-daily: files are in $endpoint, back them up with its versioning or replication" >&2
    fi
    ;;
  dir)
    files=$(setting CENACLE_FILES_DIR)
    docker run --rm --volumes-from "$($compose ps -q server | head -n 1)" -v "$work:/backup" \
      --entrypoint tar "$rclone_image" -cf /backup/files.tar -C "${files:-/data/files}" .
    ;;
  off) ;;
  *) echo "backup-daily: files are in $backend, back them up with its versioning or replication" >&2 ;;
esac

if [ -e "$work/files.tar" ]; then
  (cd "$work" && sha256sum -- *.dump settings.tgz files.tar > SHA256SUMS)
else
  (cd "$work" && sha256sum -- *.dump settings.tgz > SHA256SUMS)
fi
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
[ -d "$dest/files-removed" ] && keep "$dest/files-removed" 35

if [ -n "$remote" ]; then
  rsync -a --delete "$dest/" "$remote"
else
  echo "backup-daily: no CENACLE_BACKUP_REMOTE, the backups are on this machine only" >&2
fi
echo "backup-daily: $dir"

#!/usr/bin/env bash
set -euo pipefail
umask 077
backup_dir=/var/backups/tally
database_container=opt-db-1
database_name=tally_staging
database_user=tally_staging
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
partial="$backup_dir/tally-$stamp.dump.partial"
final="$backup_dir/tally-$stamp.dump"
install -d -m 0700 "$backup_dir"
trap 'rm -f "$partial"' EXIT
docker exec "$database_container" pg_dump --format=custom --no-owner --no-acl --username="$database_user" "$database_name" > "$partial"
test -s "$partial"
docker exec -i "$database_container" pg_restore --list < "$partial" > /dev/null
mv "$partial" "$final"
trap - EXIT
find "$backup_dir" -maxdepth 1 -type f -name 'tally-*.dump' -mtime +14 -delete

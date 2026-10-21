#!/usr/bin/env bash
# Chog Toolhub — restore the database from a backup (run as "chog"):
#   bash deploy/restore.sh                       lists the available backups
#   bash deploy/restore.sh deploy/backups/daily/chog-20261101.sql.gz
# Steps: a safety dump of the current database → stop the app → recreate the database → load the backup
# in ONE transaction (all or nothing) → start the app (migrations newer than the backup apply on start).
# Verified end-to-end against PostgreSQL 17 (backup → damage → restore → identical data, app starts).
set -euo pipefail
# Resolve the file relative to where the command was typed, then work from deploy/.
ARG=${1:-}
[ -n "$ARG" ] && [ -f "$ARG" ] && ARG="$(cd "$(dirname "$ARG")" && pwd)/$(basename "$ARG")"
cd "$(dirname "$0")"

die() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

if [ -z "$ARG" ]; then
  echo "Backups (newest first):"
  find "$(pwd)/backups" -name '*.sql.gz' -printf '%TY-%Tm-%Td %TH:%TM  %8s  %p\n' 2>/dev/null | sort -r | head -n 20
  echo
  echo "Usage: bash deploy/restore.sh <file from the list>"
  exit 0
fi

FILE=$ARG
[ -f "$FILE" ] || die "no such file: $ARG (paths are relative to where you run the command)"
gzip -t "$FILE" || die "the backup file is damaged (gzip check failed)"

echo "This REPLACES the whole live database with: $FILE"
read -rp 'Type RESTORE to continue: ' ok
[ "$ok" = RESTORE ] || die "cancelled"

SAFETY="backups/pre-restore-$(date +%Y%m%d-%H%M%S).sql.gz"
echo "==> Safety copy of the current database → $SAFETY"
docker compose exec -T db pg_dump -U chog -d chog -Z1 >"$SAFETY"

echo "==> Stopping the app"
docker compose stop app

echo "==> Recreating the database"
docker compose exec -T db psql -v ON_ERROR_STOP=1 -X -q -U chog -d postgres \
  -c 'DROP DATABASE chog WITH (FORCE)' -c 'CREATE DATABASE chog OWNER chog'

echo "==> Loading the backup (single transaction)"
if ! gunzip -c "$FILE" | docker compose exec -T db psql -v ON_ERROR_STOP=1 -X -q -U chog -d chog --single-transaction >/dev/null; then
  echo "Load failed — putting the previous database back from $SAFETY"
  docker compose exec -T db psql -v ON_ERROR_STOP=1 -X -q -U chog -d postgres \
    -c 'DROP DATABASE chog WITH (FORCE)' -c 'CREATE DATABASE chog OWNER chog'
  gunzip -c "$SAFETY" | docker compose exec -T db psql -v ON_ERROR_STOP=1 -X -q -U chog -d chog --single-transaction >/dev/null
  docker compose start app
  die "restore failed; the database is back as it was before"
fi

echo "==> Starting the app"
docker compose start app
for _ in $(seq 1 40); do
  docker compose exec -T app node -e "fetch('http://127.0.0.1:8787/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null && { echo "==> Restored and running"; exit 0; }
  sleep 3
done
docker compose logs --tail 40 app
die "the app did not become ready after the restore"

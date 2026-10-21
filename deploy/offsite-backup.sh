#!/usr/bin/env bash
# Uploads deploy/backups to Cloudflare R2 (configured by deploy/offsite-setup.sh). Run by cron every night.
# Copy-only: files are added, never deleted remotely, so a broken or compromised server cannot wipe the
# off-site copies. Set an R2 lifecycle rule on the bucket (e.g. delete after 180 days) to cap storage.
set -euo pipefail
cd "$(dirname "$0")"
[ -f .r2.env ] || { echo "deploy/.r2.env missing — run deploy/offsite-setup.sh first" >&2; exit 1; }
BUCKET=$(grep '^R2_BUCKET=' .r2.env | cut -d= -f2-)
echo "$(date -Is) uploading backups → r2:$BUCKET"
docker run --rm --env-file .r2.env -v "$(pwd)/backups:/data:ro" rclone/rclone:latest \
  copy /data "r2:$BUCKET" --exclude '*-latest.sql.gz' --exclude 'pre-restore-*' --stats-one-line -v 2>&1 | tail -n 3
echo "$(date -Is) done"

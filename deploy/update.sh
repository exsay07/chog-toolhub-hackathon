#!/usr/bin/env bash
# Chog Toolhub — update to the latest code (run as "chog" from anywhere):  bash deploy/update.sh
# Pulls master, rebuilds only the app container and restarts it; the database and its data are not
# touched (new migrations apply automatically on start). Takes a fresh backup first.
set -euo pipefail
cd "$(dirname "$0")"

echo "==> Backup before updating"
docker compose exec -T backup /backup.sh >/dev/null && echo "ok (deploy/backups)"

echo "==> Pull"
git -C .. pull --ff-only

echo "==> Rebuild and restart the app"
docker compose up -d --build app

for _ in $(seq 1 40); do
  docker compose exec -T app node -e "fetch('http://127.0.0.1:8787/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null && { echo "==> Ready"; break; }
  sleep 3
done
docker compose ps
docker image prune -f >/dev/null

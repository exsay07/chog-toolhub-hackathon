#!/usr/bin/env bash
# Chog Toolhub — set one API key / setting in deploy/.env.production and restart the app (run as "chog"):
#   bash deploy/set-key.sh OPENSEA_API_KEY
#   bash deploy/set-key.sh COINGECKO_PRO_API_KEY
#   bash deploy/set-key.sh RPC_MONAD
# The value is typed hidden and never echoed. An empty value clears the setting.
set -euo pipefail
cd "$(dirname "$0")"
die() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

NAME=${1:-}
[[ $NAME =~ ^[A-Z][A-Z0-9_]{2,40}$ ]] || die "usage: bash deploy/set-key.sh NAME   (e.g. OPENSEA_API_KEY)"
case $NAME in
  NODE_ENV | DATABASE_URL | APP_ORIGIN | NFT_GATE_DEV_ALLOWLIST | EXTRA_ORIGINS)
    die "$NAME is managed by install.sh / docker-compose — not changed here" ;;
esac
[ -f .env.production ] || die "deploy/.env.production missing — run deploy/install.sh first"

read -rsp "Value for $NAME (hidden, paste once, Enter): " VALUE
echo
[[ $VALUE == *$'\n'* || $VALUE == *' '* ]] && die "the value must be one line without spaces"

umask 077
tmp=$(mktemp)
grep -v "^$NAME=" .env.production >"$tmp" || true
echo "$NAME=$VALUE" >>"$tmp"
mv "$tmp" .env.production
chmod 600 .env.production
unset VALUE
echo "$NAME saved ($(grep "^$NAME=" .env.production | cut -d= -f2- | tr -d '\n' | wc -c) characters)."

echo "==> Restarting the app"
docker compose up -d --force-recreate app >/dev/null
for _ in $(seq 1 40); do
  docker compose exec -T app node -e "fetch('http://127.0.0.1:8787/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null && { echo "==> Ready"; exit 0; }
  sleep 3
done
docker compose logs --tail 30 app
die "the app did not become ready — check the value"

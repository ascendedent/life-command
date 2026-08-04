#!/usr/bin/env bash
# Manual full-stack boot: Supabase (Docker) -> env sync -> web + workers.
# For automatic reboot persistence, install the systemd units instead:
#   bash scripts/install-services.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[startup] starting supabase stack..."
npx supabase start

echo "[startup] syncing env files..."
node scripts/sync-env.mjs

if systemctl --user list-unit-files finance-web.service >/dev/null 2>&1 \
   && systemctl --user list-unit-files finance-web.service | grep -q finance-web; then
  echo "[startup] restarting systemd services..."
  systemctl --user restart finance-web finance-workers
else
  echo "[startup] systemd units not installed (run: bash scripts/install-services.sh)"
  echo "[startup] starting processes directly in the background..."
  nohup node scripts/launch-web.js >/tmp/finance-web.log 2>&1 &
  nohup node scripts/launch-workers.js >/tmp/finance-workers.log 2>&1 &
fi

echo "[startup] done:"
echo "  web:    http://localhost:3141"
echo "  studio: http://127.0.0.1:54323"

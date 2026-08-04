#!/usr/bin/env bash
# Installs the systemd user units so the full stack (Supabase + web + workers)
# survives reboots. Re-run after moving the repo or changing Node versions.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

# Resolve the real node binary (fnm shells expose an ephemeral path).
NODE_BIN="$(readlink -f "$(command -v node)")"
NODE_DIR="$(dirname "$NODE_BIN")"
echo "[install] repo:  $ROOT"
echo "[install] node:  $NODE_BIN"

mkdir -p "$HOME/.config/systemd/user"
for unit in finance-supabase finance-web finance-workers; do
  sed -e "s|@ROOT@|$ROOT|g" \
      -e "s|@NODE@|$NODE_BIN|g" \
      -e "s|@NODE_DIR@|$NODE_DIR|g" \
      "scripts/units/$unit.service" > "$HOME/.config/systemd/user/$unit.service"
  echo "[install] wrote ~/.config/systemd/user/$unit.service"
done

systemctl --user daemon-reload
systemctl --user enable finance-supabase finance-web finance-workers

# Lets user services start at boot without a login session.
if loginctl enable-linger "$USER" 2>/dev/null; then
  echo "[install] lingering enabled for $USER"
else
  echo "[install] WARN: could not enable lingering — run: loginctl enable-linger $USER"
fi

echo "[install] done. Start everything with: npm run svc:start"

#!/usr/bin/env bash
# Installs the "Life Command" desktop integration: app-menu launcher, themed
# icons, and the system-tray controller service. Re-run after moving the repo.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

# Themed icons (app tile + tray states)
ICONS="$HOME/.local/share/icons/hicolor/scalable/apps"
mkdir -p "$ICONS"
cp assets/icon.svg "$ICONS/life-command.svg"
cp assets/tray/life-command-tray.svg "$ICONS/life-command-tray.svg"
cp assets/tray/life-command-tray-off.svg "$ICONS/life-command-tray-off.svg"

# Pre-render raw ARGB pixmaps for the tray (theme-cache-proof IconPixmap)
GEN="assets/tray/gen"
mkdir -p "$GEN"
for size in 22 44; do
  magick -background none assets/tray/life-command-tray.svg -resize ${size}x${size}! -depth 8 "rgba:$GEN/on-$size.rgba"
  magick -background none assets/tray/life-command-tray-off.svg -resize ${size}x${size}! -depth 8 "rgba:$GEN/off-$size.rgba"
done

# App-menu entry (replaces the old finance-command one if present)
mkdir -p "$HOME/.local/share/applications"
rm -f "$HOME/.local/share/applications/finance-command.desktop"
sed "s|@ROOT@|$ROOT|g" scripts/life-command.desktop \
  > "$HOME/.local/share/applications/life-command.desktop"
chmod +x scripts/stack-ctl.sh scripts/tray.py

# Tray controller service (graphical session scoped)
mkdir -p "$HOME/.config/systemd/user"
sed "s|@ROOT@|$ROOT|g" scripts/units/finance-tray.service \
  > "$HOME/.config/systemd/user/finance-tray.service"
systemctl --user daemon-reload
systemctl --user enable finance-tray >/dev/null 2>&1 || true
systemctl --user restart finance-tray

command -v update-desktop-database >/dev/null 2>&1 &&
  update-desktop-database "$HOME/.local/share/applications" || true
command -v kbuildsycoca6 >/dev/null 2>&1 && kbuildsycoca6 >/dev/null 2>&1 || true
# KDE's icon loader caches aggressively; force a rescan of the new icons.
rm -f "$HOME/.cache/icon-cache.kcache"
touch "$HOME/.local/share/icons/hicolor" "$ICONS"

echo "[install] Life Command: launcher + icons + tray service installed."
echo "[install] The tray icon lives in the system tray (green = up, grey = down)."

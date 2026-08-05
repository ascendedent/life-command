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

# Window identity. `stack-ctl.sh open` prefers the installed Chrome PWA, whose
# window advertises a per-machine class (crx_<hash>) that has nothing to do with
# our launcher. Plasma matches a window to a launcher by that class, so unless
# this entry claims the SAME one, the pinned icon and the real window are two
# unrelated things — the pin stays "not running" while a second task entry
# appears. The hash is generated per machine and profile, so it can only be
# discovered here, at install time.
PWA_DESKTOP="$(grep -ls "^Name=Life Command" \
  "$HOME/.local/share/applications/"chrome-*-Default.desktop 2>/dev/null | head -1 || true)"
if [ -n "$PWA_DESKTOP" ]; then
  WMCLASS="$(sed -n 's/^StartupWMClass=//p' "$PWA_DESKTOP" | head -1)"
  echo "[install] PWA detected — adopting its window class: ${WMCLASS:-<none>}"
else
  # No PWA installed: `open` falls back to `--app` + `--class=life-command`.
  WMCLASS="life-command"
  echo "[install] no PWA installed — window class: life-command"
fi
[ -n "$WMCLASS" ] || WMCLASS="life-command"

sed -e "s|@ROOT@|$ROOT|g" -e "s|@WMCLASS@|$WMCLASS|g" scripts/life-command.desktop \
  > "$HOME/.local/share/applications/life-command.desktop"

# Two launchers claiming one window is ambiguous — Plasma may bind the window to
# whichever it finds first. Hide Chrome's generated entry from the menu so ours
# is the only visible way in; the file must stay on disk because `open` still
# launches through it.
if [ -n "$PWA_DESKTOP" ] && ! grep -q "^NoDisplay=true" "$PWA_DESKTOP"; then
  printf 'NoDisplay=true\n' >> "$PWA_DESKTOP"
  echo "[install] hid the duplicate Chrome PWA entry from the app menu"
fi

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

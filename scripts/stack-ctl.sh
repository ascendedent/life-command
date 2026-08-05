#!/usr/bin/env bash
# Desktop control for the stack — used by the "Life Command" launcher and
# tray (scripts/life-command.desktop, scripts/tray.py). Fine to run by hand.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_URL="http://localhost:3141"
STUDIO_URL="http://127.0.0.1:54323"
ICON="$ROOT/assets/icon.svg"

notify() {
  command -v notify-send >/dev/null 2>&1 &&
    notify-send -a "Life Command" -i "$ICON" "$1" "${2:-}" || true
}

web_up() { curl -fsS -o /dev/null --max-time 2 "$APP_URL/login"; }

start_all() { systemctl --user start finance-supabase finance-web finance-workers; }

wait_for_web() {
  for _ in $(seq 1 60); do web_up && return 0; sleep 2; done
  return 1
}

# Once the dashboard is installed as a Chrome PWA, prefer launching that —
# installed apps get their own window identity (correct taskbar grouping and
# pinning on Wayland, which plain --app windows never do in a shared Chrome
# process).
pwa_desktop() {
  grep -ls "^Name=Life Command" "$HOME/.local/share/applications/"chrome-*-Default.desktop 2>/dev/null | head -1
}

ensure_tray() {
  systemctl --user start finance-tray >/dev/null 2>&1 || true
}

case "${1:-open}" in
  open)
    ensure_tray
    if ! web_up; then
      notify "Starting Life Command stack…" "Supabase + web + workers (first start takes a moment)"
      start_all
      wait_for_web || { notify "Stack failed to start" "Check: npm run svc:status"; exit 1; }
    fi
    PWA="$(pwa_desktop)"
    if [ -n "$PWA" ]; then
      exec gio launch "$PWA" >/dev/null 2>&1
    fi
    exec google-chrome --app="$APP_URL" --class=life-command --wayland-app-id=life-command >/dev/null 2>&1
    ;;
  start)
    ensure_tray
    start_all
    wait_for_web && notify "Life Command stack running" "$APP_URL" \
                 || notify "Stack starting…" "Web not up yet — check npm run svc:status"
    ;;
  close)
    # Close Life Command app windows via KWin scripting. Only touches windows
    # whose class marks them as a PWA/app window — never plain google-chrome
    # (that would take the whole browser with it).
    # Was a window actually open? KWin script output is not reliably readable
    # from here, so establish the fact before and after in the shell instead —
    # a close that matches nothing is a bug, and used to pass silently.
    app_window_pids() {
      PWA="$(pwa_desktop)"
      if [ -n "$PWA" ]; then
        APPID="$(sed -n 's/.*--app-id=\([a-z]*\).*/\1/p' "$PWA" | head -1)"
        [ -n "$APPID" ] && pgrep -f -- "--app-id=$APPID" || true
      fi
      pgrep -f -- "--class=life-command" || true
    }
    BEFORE="$(app_window_pids | wc -l)"

    TMP=$(mktemp /tmp/lc-close-XXXXXX.js)
    cat > "$TMP" <<'JS'
// A Chrome app window identifies differently depending on how it was opened:
//   crx_<hash>            — installed PWA (what `open` prefers)
//   chrome-<hash>-Default — PWA, as some Chrome/KWin versions report app_id
//   life-command          — the plain --app fallback, when no PWA is installed
// Matching only "chrome-" missed the PWA case entirely, so close matched
// nothing. Accept all three, and never plain google-chrome — that would take
// the whole browser down with it.
workspace.windowList().forEach(function (w) {
  var cls = String(w.resourceClass || "");
  var cap = String(w.caption || "");
  var isAppWindow =
    cls.indexOf("crx_") === 0 ||
    cls.indexOf("chrome-") === 0 ||
    cls === "life-command";
  if (isAppWindow && cap.indexOf("Life Command") !== -1) {
    w.closeWindow();
  }
});
JS
    SID=$(gdbus call --session --dest org.kde.KWin --object-path /Scripting \
      --method org.kde.kwin.Scripting.loadScript "$TMP" lcclose 2>/dev/null | grep -oE '[0-9]+' | head -1)
    if [ -n "$SID" ]; then
      gdbus call --session --dest org.kde.KWin --object-path "/Scripting/Script$SID" \
        --method org.kde.kwin.Script.run >/dev/null 2>&1
      sleep 1
      gdbus call --session --dest org.kde.KWin --object-path /Scripting \
        --method org.kde.kwin.Scripting.unloadScript lcclose >/dev/null 2>&1
    fi
    rm -f "$TMP"

    AFTER="$(app_window_pids | wc -l)"
    if [ "$BEFORE" -eq 0 ]; then
      echo "[close] no Life Command window was open"
    elif [ "$AFTER" -ge "$BEFORE" ]; then
      # The window survived: the class match is wrong again, or KWin scripting
      # is unavailable. Say so rather than pretending the close worked.
      echo "[close] WARNING: $BEFORE window process(es) still present — nothing matched." >&2
      notify "Could not close the window" "Re-run scripts/install-desktop.sh; the window class may have changed"
    else
      echo "[close] closed Life Command window(s)"
    fi
    ;;
  stop)
    systemctl --user stop finance-web finance-workers finance-supabase
    notify "Life Command stack stopped" "All services and Docker containers are down"
    ;;
  restart)
    systemctl --user restart finance-web finance-workers
    notify "Web + workers restarted" "$APP_URL"
    ;;
  status)
    s="$(systemctl --user is-active finance-supabase finance-web finance-workers 2>&1 | paste -sd/ -)"
    web_up && w="reachable" || w="not reachable"
    notify "Life Command stack: $s" "Web: $w — $APP_URL"
    echo "supabase/web/workers: $s; web: $w"
    ;;
  studio)
    exec google-chrome --app="$STUDIO_URL" --class=life-studio --wayland-app-id=life-studio >/dev/null 2>&1
    ;;
  *)
    echo "usage: stack-ctl.sh [open|start|stop|restart|status|studio]" >&2
    exit 2
    ;;
esac

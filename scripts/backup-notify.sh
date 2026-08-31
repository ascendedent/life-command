#!/usr/bin/env bash
# Fired by systemd's OnFailure when a backup does not complete.
#
# A backup that stops running is indistinguishable from one that runs, right up
# until you need it. This install went three days with no database at all and
# nothing said so; a nightly job failing quietly into the journal is the same
# silence with extra steps.
#
# Two channels on purpose: a desktop toast for when someone is at the machine,
# and a push for when they are not — which is the case that actually matters,
# because the failure that hurts is the one nobody was sitting there to see.
set -uo pipefail
cd "$(dirname "$0")/.."

LAST=$(ls -t ../"Supabase Backup - Finance Dashboard"/*.dump 2>/dev/null | head -1)
if [ -n "$LAST" ]; then
  AGE_DAYS=$(( ( $(date +%s) - $(stat -c %Y "$LAST") ) / 86400 ))
  DETAIL="Last good backup: $(basename "$LAST") (${AGE_DAYS}d ago)"
else
  DETAIL="No backup has ever completed."
fi

notify-send -u critical "Finance Dashboard backup FAILED" "$DETAIL — check: journalctl --user -u finance-backup" 2>/dev/null || true

# The app already carries a push topic for recaps and alerts; reuse it rather
# than inventing a second channel the owner has to remember to watch.
if [ -f .env ]; then
  TOPIC=$(grep -E '^NTFY_TOPIC=' .env | cut -d= -f2- | tr -d '"'"'"' \r')
  if [ -n "${TOPIC:-}" ]; then
    curl -fsS -X POST "https://ntfy.sh/${TOPIC}" \
      -H "Content-Type: application/json" \
      -d "$(printf '{"topic":"%s","title":"Finance Dashboard backup failed","priority":4,"tags":["rotating_light"],"message":"%s"}' \
            "$TOPIC" "$DETAIL")" >/dev/null 2>&1 || true
  fi
fi

echo "[backup-notify] alerted: $DETAIL"

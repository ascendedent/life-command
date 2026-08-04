#!/usr/bin/env bash
# Makes Docker publish container ports on 127.0.0.1 by default instead of
# 0.0.0.0, so the Supabase stack (DB, Studio, API) is unreachable from the
# LAN. Run with: sudo bash scripts/harden-docker-loopback.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: sudo bash scripts/harden-docker-loopback.sh" >&2
  exit 1
fi

echo "[harden] setting default publish address to 127.0.0.1 in /etc/docker/daemon.json"
python3 - <<'EOF'
import json, os
path = "/etc/docker/daemon.json"
conf = {}
if os.path.exists(path):
    raw = open(path).read().strip()
    if raw:
        conf = json.loads(raw)
# "ip" covers the default bridge; user-defined networks (docker compose,
# supabase CLI) only honor the per-network binding option, so set it as the
# default for every newly created bridge network too.
conf["ip"] = "127.0.0.1"
opts = conf.setdefault("default-network-opts", {}).setdefault("bridge", {})
opts["com.docker.network.bridge.host_binding_ipv4"] = "127.0.0.1"
with open(path, "w") as f:
    json.dump(conf, f, indent=2)
    f.write("\n")
print("[harden] daemon.json now:", json.dumps(conf))
EOF

echo "[harden] restarting docker (running containers will restart)..."
systemctl restart docker

# Full stop/start (not restart) so supabase's own docker network is removed
# and recreated — the new binding default only applies to new networks.
if [ -n "${SUDO_USER:-}" ]; then
  uid="$(id -u "$SUDO_USER")"
  echo "[harden] recreating supabase stack as $SUDO_USER..."
  sudo -u "$SUDO_USER" XDG_RUNTIME_DIR="/run/user/$uid" \
    systemctl --user stop finance-supabase
  sudo -u "$SUDO_USER" XDG_RUNTIME_DIR="/run/user/$uid" \
    systemctl --user start finance-supabase
fi

echo "[harden] verification — supabase ports should now show 127.0.0.1:"
ss -tln | grep -E ':(54321|54322|54323|54324|54327) ' || true
echo "[harden] done. Other docker projects that need LAN access can override"
echo "         per-port, e.g.:  -p 0.0.0.0:8080:80"

#!/usr/bin/env bash
# Deploy the latest main to the sports VPS checkout and restart services.
# Run ON the VPS: bash /opt/sports-arb/deploy/deploy-vps.sh [service...]
#
# Handles the two sources of working-tree drift that block plain `git pull`:
#   1. package-lock.json gets rewritten by `npm install --omit=dev` (dev deps
#      pruned from the lock). We discard that noise before pulling and use
#      `npm ci` afterwards, which never rewrites the lock.
#   2. Tracked analysis files regenerated in place by nightly jobs (e.g.
#      analysis/shape-roi-*.json). `--autostash` carries those across the pull.
set -euo pipefail

REPO_DIR="${SPORTS_ARB_REPO_DIR:-/opt/sports-arb}"
SERVICES=("${@:-sports-arb-daemon}")

cd "$REPO_DIR"

echo "[deploy] repo: $REPO_DIR ($(git rev-parse --short HEAD))"

# Lock-file changes are always install noise, never intentional VPS edits.
git checkout -- package-lock.json 2>/dev/null || true

git pull --rebase --autostash origin main
echo "[deploy] now at $(git rev-parse --short HEAD): $(git log -1 --format=%s)"

# npm ci installs exactly what the lock says and leaves the lock untouched.
npm ci --omit=dev

for svc in "${SERVICES[@]}"; do
  systemctl restart "$svc"
done
sleep 5
for svc in "${SERVICES[@]}"; do
  state="$(systemctl is-active "$svc" || true)"
  echo "[deploy] $svc: $state"
  if [[ "$state" != "active" ]]; then
    journalctl -u "$svc" --since "-1 min" --no-pager | tail -20
    exit 1
  fi
done

echo "[deploy] done"

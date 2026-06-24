#!/usr/bin/env bash
# Production wrapper for the sports-arb always-on websocket daemon.
# Deployed to: /usr/local/bin/run-sports-arb-daemon on the sports VPS.
# Invoked by:  systemd unit sports-arb-daemon.service (Type=simple, Restart=always).
#
# This wrapper owns only the sports-arb repo/runtime. It intentionally does not
# stop or coordinate the parent polymarket-trader hourly trader.
set -euo pipefail

ENV_FILE="${SPORTS_ARB_ENV_FILE:-/etc/sports-arb.env}"

if [[ -r "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

REPO_DIR="${SPORTS_ARB_REPO_DIR:-/opt/sports-arb}"
STATE_DIR="${SPORTS_ARB_STATE_DIR:-/var/lib/sports-arb}"
DATA_DIR="${SPORTS_ARB_DATA_DIR:-$STATE_DIR/data}"
RUNTIME_DIR="${SPORTS_ARB_RUNTIME_DIR:-$STATE_DIR/runtime}"
LOCK_FILE="${SPORTS_ARB_DAEMON_LOCK_FILE:-$RUNTIME_DIR/sports-arb-daemon.lock}"

export SPORTS_ARB_STATE_DIR="$STATE_DIR"
export SPORTS_ARB_DATA_DIR="$DATA_DIR"
export SPORTS_ARB_RUNTIME_DIR="$RUNTIME_DIR"

mkdir -p "$STATE_DIR" "$DATA_DIR" "$RUNTIME_DIR"
chmod 700 "$STATE_DIR" "$RUNTIME_DIR" || true

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Another sports-arb daemon instance is already active; exiting."
  exit 0
fi

cd "$REPO_DIR"

if [[ "${SPORTS_ARB_DAEMON_PULL_ON_START:-${ARB_DAEMON_PULL_ON_START:-0}}" == "1" ]]; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Pulling latest sports-arb code before daemon start"
  git pull --rebase --autostash origin main || echo "WARNING: git pull failed; starting daemon on existing checkout"
  npm ci || echo "WARNING: npm ci failed; starting daemon on existing node_modules"
fi

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Starting sports-arb daemon"
exec npx tsx scripts/polymarket-arb-daemon.ts

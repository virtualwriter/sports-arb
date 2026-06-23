#!/usr/bin/env bash
# Production wrapper for the always-on Polymarket websocket arb daemon.
# Deployed to: /usr/local/bin/run-polymarket-arb-daemon on the Japan VPS.
# Invoked by:  systemd unit polymarket-arb-daemon.service (Type=simple, Restart=always).
#
# This is the SINGLE real-PM executor on Japan. The hourly
# polymarket-real-executor.timer MUST be disabled before enabling this service,
# otherwise packages can be double-submitted.
#
# Behaviour:
#   1. Acquires a non-blocking flock so two daemon instances cannot overlap.
#   2. Loads the Japan executor env (/etc/polymarket-pm-executor.env or the
#      legacy /etc/polymarket-trader.env), which must include POLYGON_RPC_URLS
#      for the multi-RPC failover provider.
#   3. Optionally pulls latest code once on start (ARB_DAEMON_PULL_ON_START=1).
#   4. Execs the long-running daemon (it manages its own websockets/timers).
set -euo pipefail

LOCK_FILE="/var/lock/polymarket-arb-daemon.lock"
REPO_DIR="${POLYMARKET_TRADER_REPO_DIR:-/opt/polymarket-trader}"
STATE_DIR="${POLYMARKET_TRADER_STATE_DIR:-/var/lib/polymarket-trader}"
export POLYMARKET_TRADER_STATE_DIR="$STATE_DIR"
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR" || true

for env_file in /etc/polymarket-pm-executor.env /etc/polymarket-trader.env; do
  if [[ -f "$env_file" ]]; then
    set -a
    # shellcheck disable=SC1090
    . "$env_file"
    set +a
  fi
done

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Another arb daemon instance is already active; exiting."
  exit 0
fi

cd "$REPO_DIR"

if [[ "${ARB_DAEMON_PULL_ON_START:-0}" == "1" ]]; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Pulling latest code before daemon start"
  git pull --rebase --autostash origin main || echo "WARNING: git pull failed; starting daemon on existing checkout"
  npm ci || echo "WARNING: npm ci failed; starting daemon on existing node_modules"
fi

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Starting Polymarket arb daemon"
exec npx tsx scripts/polymarket-arb-daemon.ts

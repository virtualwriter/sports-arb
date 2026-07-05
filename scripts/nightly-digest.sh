#!/usr/bin/env bash
# Pause the websocket daemon briefly so nightly LLM/report jobs don't OOM on
# the 3.7GB VPS, then resume trading. Ledger files on disk are read directly.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DAEMON_UNIT="${SPORTS_ARB_DAEMON_UNIT:-sports-arb-daemon.service}"
STOPPED=0

pause_daemon() {
  if systemctl is-active --quiet "$DAEMON_UNIT"; then
    echo "[nightly-digest] stopping $DAEMON_UNIT to free memory"
    systemctl stop "$DAEMON_UNIT"
    STOPPED=1
    sleep 2
  fi
}

resume_daemon() {
  if [[ "$STOPPED" == "1" ]]; then
    echo "[nightly-digest] starting $DAEMON_UNIT"
    systemctl start "$DAEMON_UNIT"
  fi
}

trap resume_daemon EXIT

run_npm() {
  sudo -u sports-arb -E env \
    SPORTS_ARB_STATE_DIR="${SPORTS_ARB_STATE_DIR:-/var/lib/sports-arb}" \
    SPORTS_ARB_DATA_DIR="${SPORTS_ARB_DATA_DIR:-/var/lib/sports-arb/data}" \
    SPORTS_ARB_RUNTIME_DIR="${SPORTS_ARB_RUNTIME_DIR:-/var/lib/sports-arb/runtime}" \
    NODE_NO_WARNINGS=1 \
    NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=768}" \
    npm run "$@"
}

MODE="${1:-telegram}"

pause_daemon

case "$MODE" in
  llm)
    run_npm llm:learn
    ;;
  telegram)
    run_npm report:daily
    run_npm report:pnl
    run_npm telegram:daily
    ;;
  full)
    run_npm llm:learn
    run_npm report:daily
    run_npm report:pnl
    run_npm telegram:daily
    ;;
  *)
    echo "usage: $0 {llm|telegram|full}" >&2
    exit 1
    ;;
esac

echo "[nightly-digest] done mode=$MODE"

#!/usr/bin/env bash
# Launch GOT $20/city Kalshi roll daemon (honors WEATHER_GOT_ROLL_LIVE).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p .runtime
LOG=".runtime/weather-got-roll.log"
PID_FILE=".runtime/weather-got-roll.pid"

if [[ -f /etc/sports-arb.env ]]; then set -a; # shellcheck disable=SC1091
  source /etc/sports-arb.env; set +a; fi
if [[ -f /etc/kalshi.env ]]; then set -a; # shellcheck disable=SC1091
  source /etc/kalshi.env; set +a; fi

export WEATHER_GOT_ROLL_STAKE_USD="${WEATHER_GOT_ROLL_STAKE_USD:-20}"
export WEATHER_GOT_ROLL_MAX_DAILY_USD="${WEATHER_GOT_ROLL_MAX_DAILY_USD:-100}"
export WEATHER_GOT_ROLL_EARLIEST_LOCAL_HOUR="${WEATHER_GOT_ROLL_EARLIEST_LOCAL_HOUR:-7}"

if pgrep -f "weather-got-roll-daemon.ts" >/dev/null 2>&1; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) already running" | tee -a "$LOG"
  exit 0
fi

nohup npx tsx scripts/weather-got-roll-daemon.ts >>"$LOG" 2>&1 &
echo $! >"$PID_FILE"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) started pid=$! live=${WEATHER_GOT_ROLL_LIVE:-0}" | tee -a "$LOG"

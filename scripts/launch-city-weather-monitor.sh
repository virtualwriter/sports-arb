#!/usr/bin/env bash
# Start a city's daily weather + Kalshi monitor for the city's local calendar day.
#
#   bash scripts/launch-city-weather-monitor.sh --city chicago
#   bash scripts/launch-city-weather-monitor.sh --city nyc --day 26AUG05
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p .runtime .tmp

CITY=""
DAY=""
EXTRA=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --city)
      CITY="${2:-}"; shift 2 ;;
    --day)
      DAY="${2:-}"; shift 2 ;;
    *)
      EXTRA+=("$1"); shift ;;
  esac
done

if [[ -z "$CITY" ]]; then
  echo "usage: $0 --city chicago|nyc|miami|austin|la [--day YYMONDD]" >&2
  exit 2
fi

CITY_LC="$(printf '%s' "$CITY" | tr '[:upper:]' '[:lower:]')"

if [[ -z "$DAY" ]]; then
  DAY="$(
    CITY_KEY="$CITY_LC" python3 - <<'PY'
import os
from datetime import datetime
from zoneinfo import ZoneInfo
import sys
sys.path.insert(0, "scripts")
from lib.weather_cities import get_city
city = get_city(os.environ["CITY_KEY"])
now = datetime.now(ZoneInfo(city.local_tz))
months = "JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC".split()
print(f"{str(now.year)[2:]}{months[now.month - 1]}{now.day:02d}")
PY
  )"
fi

DAY_LC="$(printf '%s' "$DAY" | tr '[:upper:]' '[:lower:]')"
if [[ "$CITY_LC" == "chicago" || "$CITY_LC" == "chi" ]]; then
  OUT=".tmp/chi-weather-${DAY_LC}-monitor.jsonl"
else
  OUT=".tmp/${CITY_LC}-weather-${DAY_LC}-monitor.jsonl"
fi
PID_FILE=".runtime/${CITY_LC}-weather-monitor.pid"
LOG=".runtime/${CITY_LC}-weather-monitor.log"
# Already on today's day for this city → leave it.
if pgrep -f "monitor_city_weather_day.py --city ${CITY_LC} --day ${DAY}" >/dev/null 2>&1; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) already running city=$CITY_LC day=$DAY" | tee -a "$LOG"
  exit 0
fi

# Kill this city's prior monitor only (never other cities).
if pgrep -f "monitor_city_weather_day.py --city ${CITY_LC}" >/dev/null 2>&1; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) killing prior ${CITY_LC} monitor to start $DAY" | tee -a "$LOG"
  pkill -f "monitor_city_weather_day.py --city ${CITY_LC}" 2>/dev/null || true
  sleep 2
fi
# Legacy Chicago entrypoint (pre-multi-city shim)
if [[ "$CITY_LC" == "chicago" || "$CITY_LC" == "chi" ]]; then
  if pgrep -f "monitor_chi_weather_day.py" >/dev/null 2>&1; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) killing legacy chi monitor" | tee -a "$LOG"
    pkill -f "monitor_chi_weather_day.py" 2>/dev/null || true
    sleep 1
  fi
fi

if [[ -f "$HOME/.config/sports-arb/chi-weather.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$HOME/.config/sports-arb/chi-weather.env"
  set +a
fi

export PYTHONPATH=scripts
export PYTHONUNBUFFERED=1

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) starting city=$CITY_LC day=$DAY out=$OUT" | tee -a "$LOG"

city_day() {
  CITY_KEY="$CITY_LC" python3 - <<'PY'
import os, sys
from datetime import datetime
from zoneinfo import ZoneInfo
sys.path.insert(0, "scripts")
from lib.weather_cities import get_city
city = get_city(os.environ["CITY_KEY"])
now = datetime.now(ZoneInfo(city.local_tz))
months = "JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC".split()
print(f"{str(now.year)[2:]}{months[now.month - 1]}{now.day:02d}")
PY
}

while true; do
  /usr/bin/python3 scripts/monitor_city_weather_day.py \
    --city "$CITY_LC" \
    --day "$DAY" \
    --out "$OUT" \
    "${EXTRA[@]+"${EXTRA[@]}"}" &
  child=$!
  echo "$child" >"$PID_FILE"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) monitor pid=$child city=$CITY_LC day=$DAY" | tee -a "$LOG"

  rc=0
  while kill -0 "$child" 2>/dev/null; do
    NOW_DAY="$(city_day)"
    if [[ "$NOW_DAY" != "$DAY" ]]; then
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) day rolled $DAY -> $NOW_DAY; stopping child $child" | tee -a "$LOG"
      kill "$child" 2>/dev/null || true
      wait "$child" 2>/dev/null || true
      exit 0
    fi
    sleep 60
  done
  set +e
  wait "$child"
  rc=$?
  set -e
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) monitor exit rc=$rc city=$CITY_LC day=$DAY" | tee -a "$LOG"

  NOW_DAY="$(city_day)"
  if [[ "$NOW_DAY" != "$DAY" ]]; then
    exit 0
  fi
  if [[ "$rc" -eq 0 ]]; then
    exit 0
  fi
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) restarting in 30s (rc=$rc)" | tee -a "$LOG"
  sleep 30
done

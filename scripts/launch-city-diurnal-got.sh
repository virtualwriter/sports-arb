#!/usr/bin/env bash
# Start the standalone GOT diurnal shadow monitor for one city.
# Separate from the active city weather monitor (does not replace it).
#
#   bash scripts/launch-city-diurnal-got.sh --city chicago
#   bash scripts/launch-city-diurnal-got.sh --city nyc --day 26AUG09
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
    --city) CITY="${2:-}"; shift 2 ;;
    --day) DAY="${2:-}"; shift 2 ;;
    *) EXTRA+=("$1"); shift ;;
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
  )"
fi

DAY_LC="$(printf '%s' "$DAY" | tr '[:upper:]' '[:lower:]')"
if [[ "$CITY_LC" == "chicago" || "$CITY_LC" == "chi" ]]; then
  OUT=".tmp/chi-diurnal-got-${DAY_LC}-monitor.jsonl"
  SRC=".tmp/chi-weather-${DAY_LC}-monitor.jsonl"
else
  OUT=".tmp/${CITY_LC}-diurnal-got-${DAY_LC}-monitor.jsonl"
  SRC=".tmp/${CITY_LC}-weather-${DAY_LC}-monitor.jsonl"
fi
PID_FILE=".runtime/${CITY_LC}-diurnal-got.pid"
LOG=".runtime/${CITY_LC}-diurnal-got.log"

if pgrep -f "monitor_city_diurnal_got.py --city ${CITY_LC} --day ${DAY}" >/dev/null 2>&1; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) already running got city=$CITY_LC day=$DAY" | tee -a "$LOG"
  exit 0
fi

if pgrep -f "monitor_city_diurnal_got.py --city ${CITY_LC}" >/dev/null 2>&1; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) killing prior got ${CITY_LC}" | tee -a "$LOG"
  pkill -f "monitor_city_diurnal_got.py --city ${CITY_LC}" 2>/dev/null || true
  sleep 1
fi

if [[ -f "$HOME/.config/sports-arb/chi-weather.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$HOME/.config/sports-arb/chi-weather.env"
  set +a
fi

export PYTHONPATH=scripts
export PYTHONUNBUFFERED=1

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) starting got city=$CITY_LC day=$DAY src=$SRC out=$OUT" | tee -a "$LOG"

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
  /usr/bin/python3 scripts/monitor_city_diurnal_got.py \
    --city "$CITY_LC" \
    --day "$DAY" \
    --source "$SRC" \
    --out "$OUT" \
    "${EXTRA[@]+"${EXTRA[@]}"}" &
  child=$!
  echo "$child" >"$PID_FILE"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) got pid=$child city=$CITY_LC day=$DAY" | tee -a "$LOG"

  rc=0
  while kill -0 "$child" 2>/dev/null; do
    NOW_DAY="$(city_day)"
    if [[ "$NOW_DAY" != "$DAY" ]]; then
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) day rolled $DAY -> $NOW_DAY; stopping got $child" | tee -a "$LOG"
      kill "$child" 2>/dev/null || true
      wait "$child" 2>/dev/null || true
      DAY="$NOW_DAY"
      DAY_LC="$(printf '%s' "$DAY" | tr '[:upper:]' '[:lower:]')"
      if [[ "$CITY_LC" == "chicago" || "$CITY_LC" == "chi" ]]; then
        OUT=".tmp/chi-diurnal-got-${DAY_LC}-monitor.jsonl"
        SRC=".tmp/chi-weather-${DAY_LC}-monitor.jsonl"
      else
        OUT=".tmp/${CITY_LC}-diurnal-got-${DAY_LC}-monitor.jsonl"
        SRC=".tmp/${CITY_LC}-weather-${DAY_LC}-monitor.jsonl"
      fi
      break
    fi
    sleep 30
  done
  wait "$child" 2>/dev/null || rc=$?
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) got exited rc=$rc; restarting in 5s" | tee -a "$LOG"
  sleep 5
done

#!/usr/bin/env bash
# Score yesterday's weather paper scoreboard and persist the report.
# Runs from a systemd timer after the Central Park highs fetch (07:10 UTC),
# once all cities' local trading day has closed (LA midnight = 07:00 UTC).
set -euo pipefail

REPO="${SPORTS_ARB_REPO_DIR:-/opt/sports-arb}"
OUT_DIR="${WEATHER_SCOREBOARD_DIR:-/var/lib/sports-arb/data/weather-scoreboard}"
DAY="${1:-$(date -u -d 'yesterday' +'%y%^b%d')}"

mkdir -p "$OUT_DIR"
cd "$REPO"

report="$OUT_DIR/${DAY,,}.txt"
PYTHONPATH=scripts python3 scripts/weather_paper_scoreboard.py \
  --from "$DAY" --to "$DAY" --oleg-sigma 3.0 > "$report"

# Append the day's TOTAL row to the rolling summary for quick greps.
{
  printf '%s ' "$DAY"
  grep -E '^\s+TOTAL' "$report" | head -1
} >> "$OUT_DIR/summary.log"

echo "[weather-scoreboard] $DAY -> $report"

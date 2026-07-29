#!/usr/bin/env bash
# Stadium phone score-ping for LAD @ NYM (Citi Field) — 2026-07-24.
#
# Starts ladder-lag-race with MLB paper middles + the mobile tap UI.
# On your phone (Tailscale / tunnel to this host), open the printed URL and
# tap +1 when you see a run.
#
# Usage:
#   ./scripts/run-phone-tracker-mets-dodgers.sh
#   PLR_SCORE_PING_PORT=8787 ./scripts/run-phone-tracker-mets-dodgers.sh
#   PLR_KALSHI=0 ./scripts/run-phone-tracker-mets-dodgers.sh   # skip Kalshi WS
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Dodgers @ Mets, Fri Jul 24 2026 — first pitch 23:10Z / 7:10pm ET at Citi Field.
export PLR_MODE="${PLR_MODE:-mlb}"
export PLR_SLUG="${PLR_SLUG:-mlb-lad-nym-2026-07-24}"
export PLR_KALSHI_EVENT="${PLR_KALSHI_EVENT:-KXMLBTOTAL-26JUL241910LADNYM}"
export PLR_KALSHI="${PLR_KALSHI:-1}"
export PLR_MLB_PAPER_ALL_SHAPES="${PLR_MLB_PAPER_ALL_SHAPES:-1}"
export PLR_PAPER_MIDDLES="${PLR_PAPER_MIDDLES:-1}"

# Phone UI (required for stadium taps).
export PLR_SCORE_PING_PORT="${PLR_SCORE_PING_PORT:-8787}"
export PLR_SCORE_PING_BIND="${PLR_SCORE_PING_BIND:-0.0.0.0}"
export PLR_AWAY_LABEL="${PLR_AWAY_LABEL:-DODGERS}"
export PLR_HOME_LABEL="${PLR_HOME_LABEL:-METS}"

# Optional fixed token so the phone bookmark survives restarts.
# export PLR_SCORE_PING_TOKEN="your-stadium-token"

DATA_DIR="${SPORTS_ARB_DATA_DIR:-$ROOT/data}"
mkdir -p "$DATA_DIR"

echo "=== phone tracker: Dodgers @ Mets (2026-07-24) ==="
echo "slug=$PLR_SLUG  kalshi=$PLR_KALSHI_EVENT  ping=:$PLR_SCORE_PING_PORT"
echo "labels: $PLR_AWAY_LABEL @ $PLR_HOME_LABEL"
echo "tap +1 on your phone when you see the run; path RTT uses the phone clock."
echo

TSX="$ROOT/node_modules/.bin/tsx"
if [[ -x "$TSX" ]]; then
  exec "$TSX" scripts/ladder-lag-race.ts record
fi
exec npx tsx scripts/ladder-lag-race.ts record

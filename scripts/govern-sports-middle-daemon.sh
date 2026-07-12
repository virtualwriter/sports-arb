#!/usr/bin/env bash
# Govern and run the live sports monotonic-middle daemon on Japan.
#
# Default plan:
#   - Trade active sports only.
#   - Always allow clean sub-1 packages.
#   - Deploy capital into 1.10-1.25 packages.
#   - Do not trade >1.25.
#   - Trade at $20/package.
#   - If available pUSD drops below one package, keep scanning but skip entries
#     until current positions resolve and capital recycles.
#
# Usage:
#   bash scripts/govern-sports-middle-daemon.sh plan
#   sudo bash scripts/govern-sports-middle-daemon.sh apply
#   sudo bash scripts/govern-sports-middle-daemon.sh restart
#   bash scripts/govern-sports-middle-daemon.sh status
set -euo pipefail

ACTION="${1:-plan}"
ENV_FILE="${SPORTS_ARB_ENV_FILE:-/etc/sports-arb.env}"
SERVICE_NAME="${SPORTS_ARB_DAEMON_SERVICE:-sports-arb-daemon.service}"

CONFIG_NAME="${SPORTS_DAEMON_CONFIG_NAME:-sports-middle-10k-v1}"
EXECUTION_PAIR_CONFIG="${SPORTS_EXECUTION_PAIR_CONFIG:-sports-cheap-first-breakeven-prewarm}"

PACKAGE_USD="${SPORTS_PACKAGE_USD:-20}"
OPEN_CAP_USD="${SPORTS_OPEN_CAP_USD:-8000}"
MAX_DAILY_USD="${SPORTS_MAX_DAILY_USD:-8000}"
COST_RANGES="${SPORTS_ALLOWED_COST_RANGES:-}"
SPORTS_MIN_EDGE="${SPORTS_MIN_EDGE:--0.25}"
SPORTS_ENTRY_CUTOFF_MS="${SPORTS_ENTRY_CUTOFF_MS:-0}"
SPORTS_ORPHAN_DUST_SHARES="${SPORTS_ORPHAN_DUST_SHARES:-1}"
SPORTS_MAX_ENTRY_LEG_PRICE="${SPORTS_MAX_ENTRY_LEG_PRICE:-0.98}"
SOCCER_MIN_NARROW_YES_BID="${SOCCER_MIN_NARROW_YES_BID:-0.02}"
SOCCER_MAX_NARROW_YES_BID="${SOCCER_MAX_NARROW_YES_BID:-0.10}"
MLB_MIN_NARROW_YES_BID="${MLB_MIN_NARROW_YES_BID:-0.30}"
STRAT2_MLB_LIVE="${STRAT2_MLB_LIVE:-1}"
STRAT2_MAX_PACKAGE_USD="${STRAT2_MAX_PACKAGE_USD:-10}"
STRAT2_MAX_DAILY_USD="${STRAT2_MAX_DAILY_USD:-50}"
SPORTS_MAX_EVENT_USD="${SPORTS_MAX_EVENT_USD:-50}"
SPORTS_MAX_EVENT_PACKAGES="${SPORTS_MAX_EVENT_PACKAGES:-3}"
SPORTS_BLOCK_EVENT_OVERLAP="${SPORTS_BLOCK_EVENT_OVERLAP:-1}"
MAX_PER_MIN="${SPORTS_MAX_PER_MIN:-3}"
DRY_RUN="${SPORTS_DRY_RUN:-0}"

ceil_div() {
  python3 - "$1" "$2" <<'PY'
import math
import sys
num = float(sys.argv[1])
den = float(sys.argv[2])
print(max(1, math.ceil(num / den)))
PY
}

MAX_OPEN_PACKAGES="${SPORTS_MAX_OPEN_PACKAGES:-$(ceil_div "$OPEN_CAP_USD" "$PACKAGE_USD")}"

managed_env_lines() {
  cat <<EOF
SPORTS_DAEMON_CONFIG_NAME=$CONFIG_NAME
SPORTS_EXECUTION_PAIR_CONFIG=$EXECUTION_PAIR_CONFIG
ENABLE_MONOTONIC_ARB_REAL_PM=1
MONOTONIC_ARB_REAL_PM_DRY_RUN=$DRY_RUN
MONOTONIC_ARB_REAL_PM_SOURCE=scan
# Watchlist/asset allowlist: shadow-only sports (TENNIS/WOMENS_TENNIS/UFC) must
# be listed here to be scanned, but live execution is still refused for any
# adapter that is not live_enabled (see sportsExecutionBlocked).
MONOTONIC_ARB_REAL_PM_ASSETS=MLB,SOCCER,TENNIS,WOMENS_TENNIS,UFC
MONOTONIC_ARB_REAL_PM_MAX_PACKAGE_USD=$PACKAGE_USD
MONOTONIC_ARB_REAL_PM_MAX_PACKAGE_USD_CEILING=$PACKAGE_USD
MONOTONIC_ARB_REAL_PM_MAX_DAILY_USD=$MAX_DAILY_USD
MONOTONIC_ARB_REAL_PM_MAX_OPEN_PACKAGES=$MAX_OPEN_PACKAGES
MONOTONIC_ARB_REAL_PM_MIN_MARKETABLE_BUY_USD=1
ARB_DAEMON_ALLOW_SPORTS_LIVE_EXECUTION=1
ARB_DAEMON_DISCOVER_MLB_GAMES=1
ARB_DAEMON_DISCOVER_NBA_GAMES=0
ARB_DAEMON_DISCOVER_SOCCER_GAMES=1
ARB_DAEMON_DISCOVER_LADDERS=0
ARB_DAEMON_SPORTS_ALLOWED_COST_RANGES='$COST_RANGES'
ARB_DAEMON_SPORTS_MIN_EDGE=$SPORTS_MIN_EDGE
ARB_DAEMON_SPORTS_MIN_AVAILABLE_SHARES=5
ARB_DAEMON_SPORTS_MAX_SPREAD=0.04
ARB_DAEMON_SPORTS_MAX_PAIRED_SHARES=0
ARB_DAEMON_SPORTS_MAX_ENTRY_LEG_PRICE=$SPORTS_MAX_ENTRY_LEG_PRICE
ARB_DAEMON_SOCCER_MIN_NARROW_YES_BID=$SOCCER_MIN_NARROW_YES_BID
ARB_DAEMON_SOCCER_MAX_NARROW_YES_BID=$SOCCER_MAX_NARROW_YES_BID
ARB_DAEMON_MLB_MIN_NARROW_YES_BID=$MLB_MIN_NARROW_YES_BID
ARB_DAEMON_SPORTS_MAX_EVENT_USD=$SPORTS_MAX_EVENT_USD
ARB_DAEMON_SPORTS_MAX_EVENT_PACKAGES=$SPORTS_MAX_EVENT_PACKAGES
ARB_DAEMON_SPORTS_BLOCK_EVENT_OVERLAP=$SPORTS_BLOCK_EVENT_OVERLAP
# 2x reserve: only take half the displayed hedge-side touch. Full-touch sizing
# (1x) produced a 39% orphan rate on fast MLB books (Jul 6-8, -$96).
ARB_DAEMON_SPORTS_DEPTH_RESERVE_MULTIPLIER=2
ARB_DAEMON_SPORTS_PRICE_SLIPPAGE=0
ARB_DAEMON_SPORTS_ENTRY_CUTOFF_MS=$SPORTS_ENTRY_CUTOFF_MS
ARB_DAEMON_SPORTS_ORPHAN_DUST_SHARES=$SPORTS_ORPHAN_DUST_SHARES
ARB_DAEMON_SPORTS_BALANCE_HEADROOM_USD=0.5
ARB_DAEMON_SPORTS_BALANCE_HEADROOM_MULTIPLIER=1.03
ARB_DAEMON_SPORTS_HEDGE_BREAKEVEN_FILL=1
ARB_DAEMON_SPORTS_HEDGE_COMPLETION_MIN_EDGE=0
ARB_DAEMON_SPORTS_PREWARM_ORDER_META=1
ARB_DAEMON_RESPONSE_FILL_FIRST=1
ARB_DAEMON_POST_MODE=batch
ARB_DAEMON_CAPTURE_AUDIT_MIN_COST=0.95
ARB_DAEMON_CAPTURE_AUDIT_MAX_COST=1.25
ARB_DAEMON_CAPTURE_AUDIT_MIN_INTERVAL_MS=5000
ARB_DAEMON_MAX_PER_MIN=$MAX_PER_MIN
ARB_DAEMON_MAX_NAKED_SHARES_BEFORE_PAUSE=$SPORTS_ORPHAN_DUST_SHARES
ARB_DAEMON_ORPHAN_POLL_MS=1000
ARB_DAEMON_ORPHAN_STOP_CENTS=0.01
ARB_DAEMON_ORPHAN_COMPLETION_MARGIN=0.01
ARB_DAEMON_NON_SPORTS_ORPHAN_COMPLETION_MARGIN=0
ARB_DAEMON_ORPHAN_EXPIRY_BUFFER_MS=600000
ARB_DAEMON_ORPHAN_LADDER_REFRESH_MS=5000
ARB_DAEMON_ORPHAN_MIN_SHARES=1
# Strat 2: in-play MLB game-total middles priced by the calibrated Poisson
# game-state model (shadow-validated +10-14% ROI, analysis/strat2-state-score.md).
# Small sizing until forward-validated; lambdaScale frozen at the Jul 12 fit.
ARB_DAEMON_STRAT2_MLB_LIVE=$STRAT2_MLB_LIVE
ARB_DAEMON_STRAT2_LAMBDA_SCALE=1.8
ARB_DAEMON_STRAT2_EDGE_MARGIN=0.08
ARB_DAEMON_STRAT2_MAX_PACKAGE_USD=$STRAT2_MAX_PACKAGE_USD
ARB_DAEMON_STRAT2_MAX_DAILY_USD=$STRAT2_MAX_DAILY_USD
EOF
}

managed_keys_regex() {
  managed_env_lines | sed -E 's/=.*$//' | paste -sd'|' -
}

print_plan() {
  echo "Config: $CONFIG_NAME"
  echo "Execution pair config: $EXECUTION_PAIR_CONFIG"
  echo "Env file: $ENV_FILE"
  echo "Service: $SERVICE_NAME"
  echo
  echo "Managed env:"
  managed_env_lines
  echo
  echo "Derived open capital cap: approximately \$$OPEN_CAP_USD via MAX_OPEN_PACKAGES=$MAX_OPEN_PACKAGES at \$$PACKAGE_USD/package."
  echo "Allowed sports cost ranges: $COST_RANGES"
  echo "Submit pace cap: $MAX_PER_MIN/minute (conservative safety throttle; override with SPORTS_MAX_PER_MIN=...)."
  echo "Dry run: $DRY_RUN (override with SPORTS_DRY_RUN=1 for no real orders)."
}

require_root() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    echo "ERROR: $ACTION must run as root because it writes $ENV_FILE or controls systemd." >&2
    exit 1
  fi
}

apply_env() {
  require_root
  mkdir -p "$(dirname "$ENV_FILE")"
  touch "$ENV_FILE"
  chmod 600 "$ENV_FILE"

  local tmp keys
  tmp="$(mktemp)"
  keys="$(managed_keys_regex)"
  awk -v keys="^(${keys})=" '$0 !~ keys { print }' "$ENV_FILE" > "$tmp"
  {
    echo
    echo "# Managed by scripts/govern-sports-middle-daemon.sh ($CONFIG_NAME)"
    echo "# Execution pair config: $EXECUTION_PAIR_CONFIG"
    managed_env_lines
  } >> "$tmp"
  install -m 600 "$tmp" "$ENV_FILE"
  rm -f "$tmp"
  echo "Wrote governed sports daemon config to $ENV_FILE"
}

disable_legacy_sports_services() {
  require_root
  # Old extractions sometimes installed the sports websocket daemon under a
  # polymarket-* unit name. Leave the parent polymarket-trader timer alone so
  # both repos can run their own automatic trader paths.
  systemctl disable --now polymarket-arb-daemon.service 2>/dev/null || true
}

restart_daemon() {
  require_root
  disable_legacy_sports_services
  systemctl daemon-reload
  systemctl restart "$SERVICE_NAME"
  systemctl --no-pager --full status "$SERVICE_NAME" || true
}

status_daemon() {
  systemctl --no-pager --full status "$SERVICE_NAME" || true
  echo
  journalctl -u "$SERVICE_NAME" -n 80 --no-pager || true
}

case "$ACTION" in
  plan)
    print_plan
    ;;
  apply)
    print_plan
    apply_env
    ;;
  restart)
    print_plan
    apply_env
    restart_daemon
    ;;
  status)
    status_daemon
    ;;
  *)
    echo "Usage: $0 [plan|apply|restart|status]" >&2
    exit 2
    ;;
esac

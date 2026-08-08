#!/usr/bin/env bash
# Rsync local multi-city weather monitor tapes (+ logs) to the trading VPS
# so cloud agents can read them.
#
#   bash scripts/sync-weather-monitor-tapes.sh
#   WEATHER_VPS_HOST=root@72.11.157.79 bash scripts/sync-weather-monitor-tapes.sh
#   bash scripts/sync-weather-monitor-tapes.sh --watch   # every 60s
#
# Remote paths:
#   /var/lib/sports-arb/data/weather-city-monitors/*.jsonl
#   /opt/sports-arb/.tmp/*.jsonl          (symlink-friendly mirror)
#   /var/lib/sports-arb/data/weather-city-monitors/runtime/*.log

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

HOST="${WEATHER_VPS_HOST:-root@72.11.157.79}"
REMOTE_DATA="${WEATHER_VPS_DATA_DIR:-/var/lib/sports-arb/data/weather-city-monitors}"
REMOTE_TMP="${WEATHER_VPS_TMP_DIR:-/opt/sports-arb/.tmp}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new)
WATCH=0
INTERVAL="${WEATHER_SYNC_INTERVAL_SEC:-60}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --watch) WATCH=1; shift ;;
    --host) HOST="${2:-}"; shift 2 ;;
    --interval) INTERVAL="${2:-60}"; shift 2 ;;
    *)
      echo "unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

sync_once() {
  local day_glob="${WEATHER_SYNC_DAY_GLOB:-*}"
  # Bash 3.2 (macOS) friendly: no associative arrays.
  local files
  files="$(
    (
      ls -1 .tmp/*-weather-${day_glob}-monitor.jsonl 2>/dev/null || true
      ls -1 .tmp/chi-weather-${day_glob}-monitor.jsonl 2>/dev/null || true
    ) | sort -u
  )"

  if [[ -z "$files" ]]; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) no local weather monitor tapes matched"
    return 0
  fi

  local count
  count="$(printf '%s\n' "$files" | wc -l | tr -d ' ')"

  ssh "${SSH_OPTS[@]}" "$HOST" "mkdir -p '$REMOTE_DATA' '$REMOTE_DATA/runtime' '$REMOTE_TMP'"

  # shellcheck disable=SC2086
  rsync -az --partial \
    -e "ssh ${SSH_OPTS[*]}" \
    $files \
    "$HOST:$REMOTE_DATA/"

  # Mirror into repo .tmp on VPS for scripts that default to .tmp/...
  # shellcheck disable=SC2086
  rsync -az --partial \
    -e "ssh ${SSH_OPTS[*]}" \
    $files \
    "$HOST:$REMOTE_TMP/"

  local log_files
  log_files="$(
    (
      ls -1 .runtime/*-weather-monitor.log 2>/dev/null || true
      ls -1 .runtime/*-weather-monitor.launch.log 2>/dev/null || true
    ) | sort -u
  )"
  local log_count=0
  if [[ -n "$log_files" ]]; then
    log_count="$(printf '%s\n' "$log_files" | wc -l | tr -d ' ')"
    # shellcheck disable=SC2086
    rsync -az --partial \
      -e "ssh ${SSH_OPTS[*]}" \
      $log_files \
      "$HOST:$REMOTE_DATA/runtime/"
  fi

  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) synced ${count} tapes (+ ${log_count} logs) → $HOST:$REMOTE_DATA and $REMOTE_TMP"
}

if [[ "$WATCH" == "1" ]]; then
  echo "watching every ${INTERVAL}s → $HOST"
  while true; do
    sync_once || echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) sync failed (will retry)" >&2
    sleep "$INTERVAL"
  done
else
  sync_once
fi

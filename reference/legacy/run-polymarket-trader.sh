#!/usr/bin/env bash
# Production wrapper for the hourly Polymarket trader.
# Deployed to: /usr/local/bin/run-polymarket-trader on the trading VPS.
# Invoked by:  systemd unit polymarket-trader.service (timer fires hourly at minute :27).
#
# Behaviour:
#   1. Acquires a non-blocking flock so two timer invocations cannot overlap.
#   2. Auto-commits trader STATE files (data/*, relative-value/*) left behind by an
#      interrupted previous run, so they survive the upcoming git pull.
#   3. Moves generated untracked report/backtest artifacts aside before pulling, so
#      a newly tracked upstream file cannot block the hourly trader.
#   4. Pulls the latest code with --autostash so any unexpected tracked-file edits on
#      the VPS are stashed transparently and reapplied after, instead of aborting the
#      rebase with "cannot pull with rebase: You have unstaged changes" (which has
#      historically silently killed the hourly run for hours at a time).
#   5. Installs deps, snapshots markets, regenerates the heatmap, runs the engine.
#   6. Commits and pushes the resulting state changes.
set -euo pipefail

LOCK_FILE="/var/lock/polymarket-trader.lock"
REPO_DIR="/opt/polymarket-trader"
STATE_DIR="/var/lib/polymarket-trader"
export POLYMARKET_TRADER_STATE_DIR="$STATE_DIR"
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

if [[ -f /etc/polymarket-trader.env ]]; then
  set -a
  # shellcheck disable=SC1091
  . /etc/polymarket-trader.env
  set +a
fi

DATA_FILES=(
  data/daily-valuations.csv
  data/daily-macro.csv
  data/trades-detailed.csv
  data/position-snapshots.csv
  data/portfolio.json
  data/signal-weights.json
  data/hypotheses.json
  data/learning-params.json
  data/blocked-signals.json
  data/processed-closed-trades.json
  data/learning-journal.md
  data/engine-state.json
  data/llm-truth-state.json
  data/candidate-actions.json
  data/polymarket-live-packages.json
  data/polymarket-live-orders.json
  data/llm-advice.json
  data/execution-plan.json
  relative-value/index.html
  relative-value/cross_venue_relative_value.csv
  relative-value/latest.json
  relative-value/calibration/no_bias_candidates.jsonl
  relative-value/calibration/resolutions_cache.json
  relative-value/calibration/event_report.md
)

move_generated_untracked_artifacts() {
  local backup_dir="$STATE_DIR/generated-artifact-backups/$(date -u +%Y%m%dT%H%M%SZ)"
  local moved=0
  local path
  local target

  while IFS= read -r -d '' path; do
    if [[ "$moved" -eq 0 ]]; then
      mkdir -p "$backup_dir"
    fi

    target="$backup_dir/$path"
    mkdir -p "$(dirname "$target")"
    mv "$path" "$target"
    echo "Moved generated untracked artifact before git pull: $path -> $target"
    moved=1
  done < <(
    git ls-files --others --exclude-standard -z -- \
      relative-value/backtests \
      relative-value/backtest-history \
      relative-value/history \
      hyperliquid-crv-rebalancer \
      docs
  )
}

# Final safety net: if `git pull --rebase --autostash` still aborts because an
# UNTRACKED file in some path we didn't pre-empt would be overwritten by the
# incoming commit, parse the file list out of the error message, move those
# specific files into a backup dir, and retry the pull. This makes the hourly
# trader resilient to anyone (operator or agent) scp-ing a new file into the
# repo that is later introduced as a tracked file via git push. Without this,
# the historical failure mode is: every subsequent hourly run aborts with
# `error: The following untracked working tree files would be overwritten by
# merge: <path>` and `set -e` exits the wrapper with status 1.
robust_git_pull_rebase() {
  local pull_log
  pull_log=$(mktemp)
  if git pull --rebase --autostash origin main >"$pull_log" 2>&1; then
    cat "$pull_log"
    rm -f "$pull_log"
    return 0
  fi

  cat "$pull_log"
  if ! grep -q "would be overwritten by merge" "$pull_log"; then
    rm -f "$pull_log"
    return 1
  fi

  echo "WARNING: git pull aborted due to untracked files; auto-recovering."

  local backup_dir="$STATE_DIR/generated-artifact-backups/$(date -u +%Y%m%dT%H%M%SZ)-recovery"
  mkdir -p "$backup_dir"

  # Lines between the "untracked working tree files would be overwritten by
  # merge:" header and "Please move or remove them" footer are file paths
  # (tab-indented). Move each one out of the way and retry.
  local recovered=0
  local path
  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    if [[ -e "$path" ]]; then
      local target="$backup_dir/$path"
      mkdir -p "$(dirname "$target")"
      mv "$path" "$target"
      echo "Moved blocking untracked file: $path -> $target"
      recovered=$((recovered + 1))
    fi
  done < <(
    awk '/would be overwritten by merge:/{flag=1; next} /^Please move or remove/{flag=0} flag && /^\t/{sub(/^\t/, ""); print}' "$pull_log"
  )

  rm -f "$pull_log"

  if [[ "$recovered" -eq 0 ]]; then
    echo "ERROR: pull aborted on untracked-file conflict but no paths could be parsed/moved."
    return 1
  fi

  echo "Retrying git pull --rebase --autostash after moving $recovered untracked file(s)."
  git pull --rebase --autostash origin main
}

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Another trader run is already active; exiting."
  exit 0
fi

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "ANTHROPIC_API_KEY is missing. Set it in /etc/polymarket-trader.env."
  exit 1
fi

cd "$REPO_DIR"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Starting polymarket trader run"

git fetch origin main

# Preserve any state files left behind by an interrupted previous run before updating code.
for data_file in "${DATA_FILES[@]}"; do
  if [[ -e "$data_file" ]]; then
    git add -f "$data_file"
  fi
done
if ! git diff --cached --quiet; then
  git -c user.name="virtualwriter" \
      -c user.email="37585392+virtualwriter@users.noreply.github.com" \
      commit -m "recover trader state $(date -u +%Y-%m-%d-%H%M)"
fi

move_generated_untracked_artifacts

# Diagnostic: surface any unexpected tracked-file modifications so we can see when the
# autostash kicks in. These are files the wrapper does NOT explicitly manage; if they
# ever appear here it means someone (likely an agent or a manual edit on the VPS) left
# a tracked file dirty. --autostash will absorb them so the rebase still succeeds.
dirty_tracked=$(git diff --name-only)
if [[ -n "$dirty_tracked" ]]; then
  echo "WARNING: tracked files have unstaged modifications; --autostash will stash them around the pull:"
  echo "$dirty_tracked" | sed 's/^/  - /'
fi

robust_git_pull_rebase
npm ci

npx tsx scripts/market-scanner.ts --snapshot
python3 scripts/compact_instrument_snapshots.py

# Generate static Vercel report from the same snapshot data before the engine
# reads relative-value/cross_venue_relative_value.csv for live heatmap signals.
relative_value_args=(--archive-dir "$STATE_DIR/relative-value-history")
if [[ "${RELATIVE_VALUE_LIVE_QUOTES:-0}" != "0" ]]; then
  relative_value_args+=(--live-quotes)
fi
if [[ "${RELATIVE_VALUE_LIVE_HYPERLIQUID:-0}" != "0" ]]; then
  relative_value_args+=(--live-hyperliquid)
fi
if [[ "${RELATIVE_VALUE_EDGE_HISTORY:-0}" == "1" ]]; then
  relative_value_args+=(--edge-history)
fi
if ! timeout "${RELATIVE_VALUE_REPORT_TIMEOUT:-10m}" python3 scripts/cross_venue_relative_value_report.py "${relative_value_args[@]}"; then
  echo "WARNING: relative-value report timed out or failed; continuing trader run with the last available heatmap CSV."
fi

# Close the calibration loop: stamp real resolutions + forward marks into the
# NO-bias calibration log, then refresh the deduplicated event-level report.
if ! timeout "${CALIBRATION_BACKFILL_TIMEOUT:-5m}" python3 scripts/backfill_calibration_outcomes.py \
    --archive-dir "$STATE_DIR/relative-value-history" \
    --archive-dir relative-value/history; then
  echo "WARNING: calibration outcome backfill failed; labels will catch up next run."
fi
if ! timeout "${CALIBRATION_REPORT_TIMEOUT:-2m}" python3 scripts/calibration_event_report.py; then
  echo "WARNING: calibration event report failed; continuing."
fi
if [[ "${ENABLE_MONOTONIC_ARB_REAL_PM:-0}" == "1" ]]; then
  MONOTONIC_ARB_REAL_PM_SOURCE="${MONOTONIC_ARB_REAL_PM_SOURCE:-scan}" npx tsx scripts/polymarket-real-monotonic-executor.ts
fi
npx tsx scripts/trading-engine.ts

for data_file in "${DATA_FILES[@]}"; do
  if [[ -e "$data_file" ]]; then
    git add -f "$data_file"
  fi
done
if git diff --cached --quiet; then
  echo "No trader state changes to commit"
else
  git -c user.name="virtualwriter" \
      -c user.email="37585392+virtualwriter@users.noreply.github.com" \
      commit -m "scan+trade $(date -u +%Y-%m-%d-%H%M)"
  robust_git_pull_rebase
  git push origin HEAD:main
fi


# Keep transient package/tsx caches from eating disk on the small VPS.
npm cache clean --force >/dev/null 2>&1 || true
rm -rf /tmp/tsx-* /tmp/node-compile-cache

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Completed polymarket trader run"

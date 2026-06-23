#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="${SPORTS_ARB_DATA_DIR:-${SPORTS_ARB_STATE_DIR:-$(pwd)/data}}"
BACKUP_DIR="${SPORTS_ARB_BACKUP_DIR:-${STATE_DIR}/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="${BACKUP_DIR}/sports-arb-state-${STAMP}.tar.gz"

mkdir -p "${BACKUP_DIR}"
tar -czf "${ARCHIVE}" \
  -C "${STATE_DIR}" \
  sports-arb-live-packages.json \
  sports-arb-live-orders.json \
  sports-arb-market-metadata-cache.jsonl \
  sports-arb-shadows.jsonl \
  sports-arb-resolved-shadows.jsonl \
  sports-arb-shadow-bucket-summary.json \
  sports-arb-trades.csv \
  sports-arb-signal-weights.json \
  sports-arb-hypotheses.json \
  sports-arb-learning-journal.md \
  sports-arb-llm-state.json \
  sports-arb-health.json \
  sports-arb-orphan-incidents.jsonl \
  reports 2>/dev/null || true

find "${BACKUP_DIR}" -name 'sports-arb-state-*.tar.gz' -mtime +14 -delete
echo "${ARCHIVE}"

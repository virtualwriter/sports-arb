# Sports Arb

Extraction folder for Polymarket monotonic arbitrage and sports monotonic-middle work.

This folder is intended to become its own GitHub repo. It contains copied source files from the parent `polymarket-trader` repo so the current production paths are not broken during extraction.

## Main Entry Points

- `npm run scan` discovers sports monotonic packages, ranks live candidates, records shadows, and writes scanner output.
- `npm run engine:dry-run` consumes scanner output with preflight, idempotency, lifecycle timing, capital gates, and orphan shutdown checks without submitting live orders.
- `npm run engine` runs the same live engine path. Keep `SPORTS_ARB_LIVE=0` and `DISABLE_REAL_PM_TRADING=1` until operator approval.
- `npm run report:daily` writes Markdown, CSV, and Excel-compatible report artifacts under `data/reports/`.
- `npm run report:pnl` writes the daemon lifetime P&L HTML report under `data/reports/sports-pnl-report/`.
- `npm run llm:learn` runs the DeepSeek learning/journal loop with strict no-trade/no-unpause permissions.
- `npm run telegram:daily` sends the daily report and sports daemon P&L summary to the sports arb Telegram channel.
- `npm run backup` archives state files and prunes old backups.
- `npm run daemon` runs the always-on websocket monotonic-arb daemon.
- `npm run monotonic:real-pm` runs the real Polymarket monotonic executor.
- `npm run sports:daemon` applies/governs the sports middle daemon env on the Japan host.
- `npm run monotonic:middle-report` builds sports middle report rollups.
- `npm run updown:collector` runs the Japan-only Up/Down collector.

## Standalone State

Default local state lives in `data/` and `.runtime/`. Production should use `/opt/sports-arb` for code and `/var/lib/sports-arb` for state via `/etc/sports-arb.env`.

Important files include `sports-arb-live-packages.json`, `sports-arb-shadows.jsonl`, `sports-arb-market-metadata-cache.jsonl`, `sports-arb-health.json`, `sports-arb-orphan-incidents.jsonl`, `sports-arb-learning-journal.md`, and the `data/reports/` exports.

## Deployment Paths

See `docs/server-paths.md` for the Japan and Dublin path inventory found during extraction.

The sports-arb automatic path is `sports-arb-daemon.service` -> `/usr/local/bin/run-sports-arb-daemon` -> `/opt/sports-arb`. The parent polymarket-trader automatic path remains separate as `polymarket-trader.timer` -> `/usr/local/bin/run-polymarket-trader` -> `/opt/polymarket-trader`.

## Notes

- Runtime secrets belong in `config.env`, `.env`, or `/etc/sports-arb.env`; do not commit real credentials.
- `reference/legacy/trading-engine.ts` is included because the old main trader contains shadow monotonic arb logic, but it is not part of the standalone build.
- `analysis/` contains the CSV/JSON evidence used by the soccer and MLB strategy document.

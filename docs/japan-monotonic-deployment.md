# Japan Monotonic / UpDown Deployment Notes

This note documents the sports-arb monotonic tooling so it is not confused with the parent polymarket-trader hourly deployment.

## Scope

- `scripts/polymarket-arb-daemon.ts` and `scripts/polymarket-real-monotonic-executor.ts` are sports-arb monotonic execution paths in this repo.
- `scripts/updown-5m-book-collector.ts` is an experimental 5-minute Up/Down book collector/live-attempt tool.
- These scripts should run from `/opt/sports-arb` with `/etc/sports-arb.env` and `/var/lib/sports-arb` state.
- The parent polymarket-trader repo keeps its own hourly automatic trader through `polymarket-trader.timer` and `/usr/local/bin/run-polymarket-trader`.

## Live Mode Boundaries

- `scripts/updown-5m-book-collector.ts` is observation-only unless `UPDOWN_COLLECTOR_LIVE=1`.
- Non-atomic Up/Down live execution additionally requires `UPDOWN_COLLECTOR_ALLOW_NON_ATOMIC_LIVE=1`.
- Real monotonic execution remains controlled by the sports-arb monotonic executor env gates and wallet/CLOB configuration.
- `scripts/govern-sports-middle-daemon.sh restart` may disable legacy `polymarket-arb-daemon.service` installs, but it must not disable `polymarket-trader.timer` or `polymarket-trader.service`.

## Cleanup Guidance

- Keep Japan monotonic cleanup separate from USA hourly-trader cleanup.
- Do not mix Up/Down collector refactors with production `scripts/trading-engine.ts` changes.
- Before extracting helpers from the Up/Down collector, run `npm run cleanup:harness` before and after the change and confirm normalized USA trader outputs are unchanged.

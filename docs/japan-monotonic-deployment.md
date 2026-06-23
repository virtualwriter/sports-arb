# Japan Monotonic / UpDown Deployment Notes

This note documents the Japan-only Polymarket arbitrage tooling so it is not confused with the USA hourly trader deployment.

## Scope

- `scripts/polymarket-arb-daemon.ts` and `scripts/polymarket-real-monotonic-executor.ts` are Polymarket monotonic-arb execution paths.
- `scripts/updown-5m-book-collector.ts` is an experimental 5-minute Up/Down book collector/live-attempt tool.
- These scripts should not be deployed to the USA VPS unless the operator explicitly requests it.

## Live Mode Boundaries

- `scripts/updown-5m-book-collector.ts` is observation-only unless `UPDOWN_COLLECTOR_LIVE=1`.
- Non-atomic Up/Down live execution additionally requires `UPDOWN_COLLECTOR_ALLOW_NON_ATOMIC_LIVE=1`.
- Real monotonic execution remains controlled by the existing monotonic executor env gates and wallet/CLOB configuration.

## Cleanup Guidance

- Keep Japan monotonic cleanup separate from USA hourly-trader cleanup.
- Do not mix Up/Down collector refactors with production `scripts/trading-engine.ts` changes.
- Before extracting helpers from the Up/Down collector, run `npm run cleanup:harness` before and after the change and confirm normalized USA trader outputs are unchanged.

# HFT Market-Making Systems

Internalized reference from Brett Harrison (@BrettHarrison), 2026-07-23:

https://x.com/BrettHarrison/status/2080297166229094480

Agent-facing rule: `cursor-rules/hft-market-making-systems.mdc`.

## Summary

A market-making / HFT trading system is five components. AI/ML mainly sits in offline training, not the realtime tick→trade path.

| Component | Role |
|-----------|------|
| **Market data** | Realtime orderbook deltas + trades for the quoted symbol and every related instrument in fair value. Protocols: JSON/WS (slow) → FIX → binary (fast). Ingest off the trading hot path. |
| **Fair value** | Indifference price between buy and sell after fees/costs. Firm's core IP; from simple multi-param models to multivariate baskets. |
| **Order placement** | Where/how to quote and size: two-sided balance, queue, rate limits, adverse-selection cancels, sizing. Co-equal with prediction for P&L. |
| **Exchange connectivity** | Venue-specific order/cancel protocols; in-process or segregated gateway. |
| **Offline training** | Sets fair-value and placement parameters via offline compute / ML. Not in the realtime loop. Online GPU inference still uncommon; more likely as inference silicon matures. |

## Mapping onto sports-arb

| Component | Typical surfaces here |
|-----------|----------------------|
| Market data | Polymarket CLOB WS/REST, Gamma, Kalshi books, state-feed shadows |
| Fair value | Strat2 / `1 + pMiddle` gates, Skellam/state models, package EV |
| Order placement | Daemon/executor maker-taker, cancels, capital gates, orphans, sizing |
| Exchange connectivity | CLOB client, venue WS auth, VPN guards, multi-venue APIs |
| Offline training | Learning journals, shadows, ROI reports, backtests, bucket rebuilds |

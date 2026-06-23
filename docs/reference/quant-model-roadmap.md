# Path to a Quant Model

Strategic roadmap for graduating the polymarket-trader / hyperliquid-hybrid-bot system from "systematic trader with adaptive learning" to a defensible quant model. Updated as gaps close; review when shipping any structural change to sizing, calibration, or risk.

Last updated: 2026-05-29.

## TL;DR

Composite maturity: **~45% of the way to a quant model.** Asymmetric — data pipeline, signal generation, and observability are at-or-near quant-grade. Sizing, calibration, and portfolio-level risk are at hobbyist-grade and block scaling capital.

Minimal viable upgrade to "yes, this is a quant model" is **~2-3 weeks of focused work** along steps A-D below (E is optional).

## 10-Pillar Maturity Scorecard

| Pillar | Today (%) | What we have | What quant-grade looks like |
|---|---|---|---|
| 1. Data pipeline | 80 | Hourly snapshots persisted to JSONL, dual-source price/IV (CBOE+CME), gamma API for PM, multi-venue HL/PM/CBOE/CME wiring, archives gzipped. ~31k LOC. | Snapshot integrity checks, schema versioning, point-in-time replay, eventual-consistency guarantees. |
| 2. Feature engineering | 70 | 47 features per heatmap row (spot, IV, basis, funding, OI, settlement skew/tail/overround, dual-source agreement). Hand-coded transforms. | Same features + standardized normalization layer, lookback statistics computed automatically, feature freshness SLAs. |
| 3. Probabilistic model | 50 | Closed-form math (Black-Scholes terminal + one-touch reflection-principle + 1.5σ far-tail cap). No fitted model. | Either rigorously-validated closed-form *or* a trained probabilistic predictor (GBM, isotonic-calibrated logistic) with held-out validation. |
| 4. Calibration | 25 | Scaffolding exists (8,173-row JSONL with `resolved_outcome` field), per-bucket observer shipped (`oneTouchBucketObservations`). No closed loop. | Brier score by bucket, reliability diagrams, isotonic regression mapping model→empirical probabilities, recomputed weekly. |
| 5. Signal / alpha generation | 55 | Multiple signal families (one-touch, weekend HL funding, monotonic arb, hybrid bot, LLM hypothesis). Promotion gate at 65% shadow win rate over 20 trades. | Same + per-signal EV calc, signal correlation matrix, signal-decay tracking. |
| 6. Portfolio construction / sizing | 10 | `TRADE_SIZE = 1` — every position identically sized regardless of edge or confidence. Live HL bot uses fixed $10. | Sizing as a function of edge × confidence × inverse-variance × portfolio-correlation-penalty. Typical: fractional Kelly, risk-parity, or mean-variance with covariance shrinkage. |
| 7. Risk management | 30 | Per-position stops, expiry-based hold limits, drawdown-mode flag (halves sizing below 35% recent win rate), hybrid bot consecutive-loser cooldown (3 losses → 36h coin-specific short suppression, `0090238`). | Portfolio-level VaR/CVaR, correlated-position caps, sector/asset exposure limits, dynamic vol-targeting on aggregate book. |
| 8. Execution | 70 | Real HL fills with measured slippage + fees logged, PM via CLOB client. Live and shadow accounting cleanly separated. | Same + pre-trade impact modeling, optimal execution scheduling for large orders. |
| 9. Backtesting / validation | 30 | Ad-hoc Python scripts for individual strategies (funding sweep, hybrid grid, IV variant, synthetic bull stress). | Unified walk-forward framework, train/test/OOS splits enforced, regime-stratified holdouts, leakage prevention. |
| 10. Live monitoring & adaptive learning | 45 | Hypothesis system with backtest-validated promotion, shadow-trading infrastructure, per-signal weight adaptation, drawdown mode, per-bucket observer, LLM journals + email. | Model-drift alerting, signal P&L attribution at factor level, regime detection feeding parameter selection, auto-recalibration schedule. |

## Where we're at-or-near quant-grade

1. **Data infrastructure.** Multi-venue, multi-source, time-versioned, archived. Better than many small quant shops.
2. **Signal generation breadth.** LLM-driven hypothesis generator paired with deterministic shadow-trade validation. Most quant shops don't have this combination.
3. **Live execution & observability.** Real fills with fee/slippage capture, shadow vs live cleanly separated, full audit trail per shadow (`heatmapRowSnapshot`).

## Where we're at hobbyist-grade — blockers for scaling capital

### 1. Sizing is a constant

`scripts/trading-engine.ts:48` — `TRADE_SIZE = 1`. Position size is independent of edge magnitude, model confidence, or asset volatility. No `kelly`, `covariance`, or `var(` anywhere. **Even basic fractional-Kelly sizing on one-touch signals would produce a different P&L distribution from what we have now.**

### 2. No fitted probabilistic model

Probability outputs are derived from closed-form math (BS-terminal + one-touch reflection). Zero `sklearn` / `xgboost` / `torch` imports. Whether the touch-adjusted probability empirically predicts touch outcomes is currently an open question with a sample of 162. Until the calibration backfill (step A below) closes the loop, the model's pricing is theoretical not empirical.

### 3. No portfolio-level risk

Currently ~92 open shadow positions plus a real hybrid bot book. Correlation matrix is unmodeled. If BTC ripped: one-touch NO shadows, hybrid bot shorts, and weekend-funding HL stock-perp longs (all correlated to BTC / risk-on) would move against us simultaneously. System doesn't see this until P&L hits.

## Minimal Viable Quant Upgrade (A→E)

Ordered by leverage. A-D together = the smallest path to "yes, this is a quant model." E is a stretch goal.

### A. Calibration backfill ⊕ Brier scoring — ~3-4h

- New Python script `scripts/backfill_calibration_outcomes.py`.
- Reads `relative-value/calibration/no_bias_candidates.jsonl` (8,173 records).
- For each unique `market_id`, hits `gamma-api.polymarket.com` (already wired in `scripts/market-scanner.ts:96`) to fetch `outcomePrices`.
- Writes `resolved_outcome` and a forward-mark schedule back into the JSONL.
- Optional companion `scripts/calibration_curves.py` plots reliability diagrams + Brier scores per bucket.
- **Unlocks:** first real check of whether the probability model is empirically calibrated.

### B. Edge-proportional sizing — ~4-6h

- Replace `TRADE_SIZE = 1` with `size = base_size × fractional_kelly(edge, vol)` per signal family.
- Half-Kelly initially (conservative). Cap absolute position size.
- Affects every signal that uses `TRADE_SIZE` (one-touch, weekend funding, monotonic arb, LLM hypotheses).
- **Unlocks:** P&L distribution that actually responds to model confidence; high-edge slices (currently underutilized) get proportionally more capital.

### C. Walk-forward backtest framework — ~1-2 days

- Standardized OOS validation harness in `scripts/backtest/` (new dir).
- Existing per-strategy scripts (`fee_aware_hybrid_grid.py`, `iv_model_variant_backtest.py`, `synthetic_bull_stress.py`, `funding_extreme_sweep_backtest.py`, etc.) get ported in as fixtures.
- Every new signal must pass an OOS sample-out-of-fold validation before promotion.
- **Unlocks:** ability to add new signals without ad-hoc backtest scripting; consistent leakage prevention.

### D. Per-asset / per-signal covariance — ~1-2 days

- Compute rolling correlation matrix between signal P&L streams (daily).
- Hard cap on concurrent exposure to any single covariance cluster (e.g. all "long BTC delta" signals combined).
- Surface in the engine log + daily journal.
- **Unlocks:** portfolio-level risk that's actually measured, not just per-position.

### E. Fitted probability model (optional / stretch) — ~3-5 days

- Train isotonic or gradient-boosted classifier on calibration JSONL labels (post-A).
- Output as a second prob estimate that the engine can blend with the closed-form math.
- Only worth doing after (A) confirms the closed-form math has systematic bias to correct.
- **Unlocks:** a true ML-augmented quant model. Diminishing returns relative to A-D and only worthwhile if A reveals a real calibration error.

## Deferred / Adjacent Work

Items previously explored that pair naturally with the roadmap above. Both surfaced in the [Shadow trade deep dive](aded226e-055a-4eac-820e-6e61618ab338) on May 26.

### IV-variant data collection

- Backtest `scripts/iv_model_variant_backtest.py` already compares three IV-sourcing strategies for the one-touch probability:
  - **(a) Closest-strike IV** (current)
  - **(b-i) ATM IV** (skew-removed)
  - **(b-ii) Skew-adjusted IV** (interpolated correction)
- Finding: closest-strike beat both alternatives at predicting PM direction (67.5% directional accuracy in backtest), but introduced inflated edge magnitudes that don't predict outcomes.
- Deferred change: persist all three IV variants per snapshot to the relative-value heatmap so the model can be re-evaluated later without rebuilding history.
- Natural pair with **step A** (calibration backfill) — once outcomes are labelled, the variant comparison can be re-run against ground truth.

### Relative-decay edge exit ("+/- edge buffer points")

- Current logic in `oneTouchNoEdgeDisappeared()` exits when `sell_yes_edge_pts < 1pt` — an **absolute floor**.
- Deferred change: exit when current edge < X% of entry edge (relative decay; suggested 30-50%).
- Simulation on the resolved-shadow set showed a 50% relative threshold improved hypothetical P&L, but mostly via the high-entry-edge trades (>10pt). Most shadows have entry edges under 5pt, where 50% relative ≈ the existing 1pt floor.
- Natural pair with **step B** (edge-proportional sizing). High-entry-edge trades would be sized larger under fractional Kelly, so a relative-decay exit that protects exactly those trades produces compounding benefit.
- Canvas record: `canvases/shadow-trade-deep-dive.canvas.tsx` (lines 781+).

## Status Tracker

Update this table as gaps close. When a step ships, move from `pending` to a commit hash, and update the corresponding pillar(s) in the scorecard above.

| Step | Status | Commit / Notes |
|---|---|---|
| A. Calibration backfill ⊕ Brier scoring | done (2026-06-12) | `scripts/backfill_calibration_outcomes.py` stamps real UMA resolutions + h24/h72/h168 forward marks hourly via `run-polymarket-trader.sh`; `scripts/calibration_event_report.py` writes the deduplicated event-level report (`relative-value/calibration/event_report.md`, 200-resolved-event promotion bar). Same date: BTC/ETH switched to live Deribit vol (proxy penalty 0) and the one-touch model replaced with the exact reflection barrier formula. |
| B. Edge-proportional sizing | pending | `TRADE_SIZE = 1` hardcoded at `trading-engine.ts:48`. |
| C. Walk-forward backtest framework | pending | Ad-hoc scripts exist; no shared harness. |
| D. Per-asset / per-signal covariance | pending | No portfolio-level risk surfaced yet. |
| E. Fitted probability model | pending (gated on A) | No ML imports in repo. |
| Deferred: IV-variant data collection | partial | `scripts/iv_model_variant_backtest.py` writes comparison CSV but doesn't feed live model. |
| Deferred: Relative-decay edge exit | pending | Current exit uses absolute 1pt floor; relative trigger not coded. |
| Tactical: Hybrid bot consecutive-loser cooldown | shipped (`0090238`) | 3 back-to-back losing shorts (pnl ≤ −0.5%) on a coin → 36h short-suppression on that coin. INJ seeded with `loss_streak=3` to halt active bleed. Bumps Pillar 7 (Risk Management) from 25% → ~30%. |
| Tactical: LLM thesis-invalidated close for mechanical signals | shipped | `PC_RATIO_EXTREME_*` and `FUNDING_EXTREME_*` positions now permit LLM discretionary close after the 12h min-hold when the signal's own input has reversed (e.g. P/C ratio normalizes back through entry threshold; funding flips back through entry threshold). Profit-taking remains mechanical; only `thesis_invalidated` / `data_quality_issue` / `hard_portfolio_risk` categories allowed for these families. Motivated by 5/29 GOLD short post-mortem: thesis broke (P/C 0.32 → 0.64) ~16h into the trade, LLM journaled it three times, but had no authority to close — trade bled the full 2% stop. |

## Cross-References

- Per-bucket calibration observer (most recent maturity step): commit `5b6649f`, `oneTouchBucketObservations` in `scripts/trading-engine.ts`.
- Legacy one-touch data artifact cleanup: commits `d604731`, `64dae40`.
- Calibration data accumulator: `relative-value/calibration/no_bias_candidates.jsonl` (8,173 records, ~10 MB).
- Heatmap row snapshot schema: `BlockedSignalShadow.heatmapRowSnapshot` in `scripts/trading-engine.ts:551`.
- IV variant backtest: `scripts/iv_model_variant_backtest.py`.
- Relevant prior chats:
  - [Shadow trade deep dive](aded226e-055a-4eac-820e-6e61618ab338) — IV variants + relative-decay exit proposals (May 26).

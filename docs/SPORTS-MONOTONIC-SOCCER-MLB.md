# Soccer and MLB Monotonic Middle Strategy

## Source And Objective

This document covers the sports monotonic middle strategy for SOCCER and MLB, not the LMSR market-making strategy in `SPORTS-MM-STRATEGY.md`.

The goal is to target repeatable, capital-efficient paired packages where the floor outcome returns roughly 1x and the middle outcome returns 2x. Profitability is therefore a function of:

```text
observed-cost ROI x capital turnover
```

The current evidence base comes from `.tmp/monotonic-chronological-packages-long.csv`, joined to Gamma market metadata for line type and strike details:

| Sport | Resolved packages analyzed | Middle hits | Blended hit rate |
|-------|----------------------------|-------------|------------------|
| SOCCER | 1,456 | 464 | 31.9% |
| MLB | 2,355 | 451 | 19.2% |

The larger long-ledger blended hit rate is consistent with the older middle-outcomes canvas: about 27% overall.

## Global Cost Range Rules

Keep the profitable ranges, but cut the bad top of the current daemon range:

| Range | Action | Reason |
|-------|--------|--------|
| `<1.000` | Opportunistic only | Positive ROI and floor-protected, but lower capacity and slower capital efficiency. Use idle capital; do not reserve a fixed 20% sleeve. |
| `1.050-1.190` | Keep, sport/subtype filtered | Strongest SOCCER region after subtype filtering. |
| `1.190-1.220` | Keep, high priority | Best MLB bucket and still good for SOCCER. |
| `1.220-1.250` | Cut | Negative/weak overall; MLB was especially bad here. |
| `1.250-1.350` | SOCCER-selective only | Positive for SOCCER match totals/spreads, but should not be a blanket range. |

## SOCCER: Best Market Shapes

SOCCER edge is not just "soccer." It is concentrated in match-total and spread ladders with specific middle widths.

Best performing SOCCER shapes inside the better cost buckets:

| Shape | Resolved | Middles | Hit rate | Avg cost | Observed-cost ROI |
|-------|----------|---------|----------|----------|-------------------|
| Spread, 2-goal middle | 25 | 12 | 48.0% | 1.125 | +31.5% |
| Match total, 3-goal middle | 37 | 19 | 51.4% | 1.180 | +28.3% |
| Match total, 2-goal middle | 45 | 23 | 51.1% | 1.193 | +26.7% |
| Spread, 3-goal middle | 17 | 8 | 47.1% | 1.175 | +25.2% |
| Match total, 5-goal middle | 18 | 8 | 44.4% | 1.216 | +18.8% |
| Match total, 4-goal middle | 34 | 13 | 38.2% | 1.172 | +17.9% |
| Match total, 1-goal middle | 50 | 12 | 24.0% | 1.117 | +11.0% |
| Team total, 1-goal middle | 127 | 32 | 25.2% | 1.233 | +1.6% |
| Team total, 2-goal middle | 15 | 3 | 20.0% | 1.199 | +0.1% |

Recommended SOCCER allow rules:

| Market type | Preferred lines | Preferred cost ranges | Rule |
|-------------|-----------------|-----------------------|------|
| Match totals | Broad leg `2.5` or `3.5`; narrow leg `4.5-8.5` | `1.050-1.190`, `1.190-1.220`, selective `1.250-1.350` | Highest priority. These are the strongest repeatable soccer middles. |
| Spreads | Broad leg around `1.5-3.5`; 2-3 goal middle width | `1.050-1.190`, `1.190-1.220`, selective `1.250-1.350` | Good secondary target, especially 2-goal and 3-goal spread middles. |
| Team totals | Any | None by default | Do not prioritize. Only allow if a separate live sample proves edge. |

Best SOCCER line families observed:

| Line family | Resolved | Middles | Hit rate | Avg cost | Observed-cost ROI |
|-------------|----------|---------|----------|----------|-------------------|
| Total `3.5-6.5` | 20 | 9 | 45.0% | 1.166 | +24.4% |
| Total `3.5-7.5` | 20 | 9 | 45.0% | 1.180 | +22.9% |
| Total `3.5-5.5` | 24 | 8 | 33.3% | 1.118 | +19.3% |
| Total `3.5-4.5` | 24 | 6 | 25.0% | 1.048 | +19.3% |
| Total `3.5-8.5` | 20 | 9 | 45.0% | 1.220 | +18.9% |
| Total `2.5-4.5` | 24 | 9 | 37.5% | 1.198 | +14.8% |
| Total `2.5-6.5` | 20 | 11 | 55.0% | 1.363 | +13.7% |
| Total `2.5-7.5` | 20 | 11 | 55.0% | 1.371 | +13.0% |
| Spread `1.5-3.5` | 42 | 8 | 19.0% | 1.066 | +11.7% |
| Spread `1.5-4.5` | 31 | 8 | 25.8% | 1.130 | +11.4% |
| Spread `1.5-2.5` | 48 | 6 | 12.5% | 1.021 | +10.2% |

SOCCER avoid rules:

- Avoid team totals as a default allocation. In the better buckets, team totals were roughly flat: `+1.6%` for 1-goal middles and `+0.1%` for 2-goal middles.
- Avoid very high-cost, very wide `0.5`-based totals. They can show high hit rates but ROI compresses because the entry cost is too high.
- Avoid upper-tail ladders like `6.5-8.5` unless cost is exceptionally favorable.

## MLB: Best Market Shapes

MLB is much narrower than SOCCER. The broad MLB strategy is not attractive; the edge is concentrated in one cost bucket and a few total-line families.

MLB cost bucket evidence:

| Cost bucket | Resolved | Middles | Hit rate | Avg cost | Observed-cost ROI |
|-------------|----------|---------|----------|----------|-------------------|
| `1.190-1.220` | 137 | 41 | 29.9% | 1.198 | +8.5% |
| `1.220-1.250` | 93 | 17 | 18.3% | 1.230 | -3.9% |
| `1.160-1.190` | 302 | 44 | 14.6% | 1.170 | -2.0% |
| `1.250-1.350` | 369 | 102 | 27.6% | 1.285 | -0.7% |
| `1.350-1.500` | 282 | 116 | 41.1% | 1.408 | +0.2% |

MLB best subtype/width results:

| Shape | Resolved | Middles | Hit rate | Avg cost | Observed-cost ROI |
|-------|----------|---------|----------|----------|-------------------|
| `1.190-1.220`, total, 3-run middle | 18 | 7 | 38.9% | 1.204 | +15.3% |
| `1.190-1.220`, total, 2-run middle | 90 | 26 | 28.9% | 1.197 | +7.7% |
| `1.190-1.220`, spread, 2-run middle | 23 | 6 | 26.1% | 1.195 | +5.5% |

Best MLB line families observed:

| Line family | Resolved | Middles | Hit rate | Avg cost | Observed-cost ROI |
|-------------|----------|---------|----------|----------|-------------------|
| Total `5.5-7.5` | 47 | 13 | 27.7% | 1.189 | +7.4% |
| Total `6.5-7.5` | 68 | 11 | 16.2% | 1.099 | +5.7% |
| Total `5.5-8.5` | 47 | 16 | 34.0% | 1.272 | +5.4% |
| Total `6.5-8.5` | 68 | 16 | 23.5% | 1.177 | +4.9% |
| Spread `1.5-2.5` | 155 | 18 | 11.6% | 1.069 | +4.4% |

Recommended MLB allow rules:

| Market type | Preferred lines | Preferred cost range | Rule |
|-------------|-----------------|----------------------|------|
| Game totals | `5.5-7.5`, `5.5-8.5`, `6.5-7.5`, `6.5-8.5` | `1.190-1.220` | Primary MLB target. |
| Spreads | Prefer 2-run width; be cautious outside `1.190-1.220` | `1.190-1.220` only | Secondary MLB target, smaller size. |

MLB avoid rules:

- Do not trade MLB broadly below `1.190`; several buckets are flat or negative despite high turnover.
- Keep `1.220-1.250` cut.
- Avoid high-total upper-tail ladders such as `8.5-13.5`, `9.5-13.5`, `10.5-13.5`, and similar families.
- Avoid most wider spread ladders outside the narrow `1.190-1.220` pocket.

## Deployment Recommendation

Use the following tiering for dry-run and then live ramp:

| Tier | Rule | Suggested size |
|------|------|----------------|
| Tier 1 | MLB `1.190-1.220` game totals with 2-3 run middle width; SOCCER match totals/spreads in `1.100-1.190` | `$40-$50` |
| Tier 2 | SOCCER match totals/spreads in `1.050-1.100` and `1.190-1.220` | `$20-$40` |
| Tier 3 | SOCCER selective `1.250-1.350` match totals/spreads | `$20-$30` |
| Opportunistic | `<1.000` packages | Idle capital only; no reserved sleeve |
| Excluded | `1.220-1.250`, SOCCER team totals by default, broad MLB outside `1.190-1.220` | `$0` |

Implementation should enforce both cost and market-shape gates. Cost alone is too blunt.

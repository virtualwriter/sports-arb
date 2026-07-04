import type { SportsArbPackage } from "../types.js";
import { currentStrategyAllowlist } from "../sports-strategy.js";
import { loadBaselineBuckets } from "./baseline-evidence.js";
import { loadBacktestShapeEvidence } from "./backtest-shape-evidence.js";
import { aggregateLiveBuckets, type StrategyBucketsSnapshot } from "./bucket-aggregator.js";

/** Always rebuild from live ledger + in-process allowlist (never stale JSON). */
export function buildStrategySnapshot(packages: SportsArbPackage[]): StrategyBucketsSnapshot {
  const allowlist = currentStrategyAllowlist();
  const baseline = loadBaselineBuckets();
  const backtestShapes = loadBacktestShapeEvidence(allowlist);
  return aggregateLiveBuckets(packages, allowlist, baseline, backtestShapes);
}

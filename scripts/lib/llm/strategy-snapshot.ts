import { currentStrategyAllowlist } from "../sports-strategy.js";
import { loadBaselineBuckets } from "./baseline-evidence.js";
import { loadBacktestShapeEvidence } from "./backtest-shape-evidence.js";
import { aggregateLiveBuckets, type StrategyBucketsSnapshot } from "./bucket-aggregator.js";
import { loadDaemonSportsArbPackagesSync } from "./daemon-bridge.js";

/** Always rebuild from live ledger + in-process allowlist (never stale JSON). */
export function buildStrategySnapshot(): StrategyBucketsSnapshot {
  const allowlist = currentStrategyAllowlist();
  const baseline = loadBaselineBuckets();
  const backtestShapes = loadBacktestShapeEvidence(allowlist);
  const packages = loadDaemonSportsArbPackagesSync();
  return aggregateLiveBuckets(packages, allowlist, baseline, backtestShapes);
}

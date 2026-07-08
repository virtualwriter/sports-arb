// Aggregates the daemon's resolved trade ledger (active + archived) into
// per-bucket statistics keyed by (sportId, marketType, lineFamily, costBucket).
// Live stats are for execution monitoring only — gate authority comes from
// shape-level backtest evidence (loadBacktestShapeEvidence).
//
// Tiering (sample size for live monitoring):
//   preliminary  -> n >= 5
//   actionable   -> n >= 15
//   confirmed    -> n >= 30

import type { SportsArbPackage } from "../types.js";
import type { StrategyAllowlistSnapshot } from "../sports-strategy.js";
import type { BacktestShapeRow } from "./backtest-shape-evidence.js";
import { backtestMiddleRateByFamily } from "./backtest-shape-evidence.js";
import type { BaselineBucket } from "./baseline-evidence.js";
import { isSoccerBacktestEnforcedShape } from "./backtest-shape-evidence.js";

export const TIER_THRESHOLDS = {
  preliminary: 5,
  actionable: 15,
  confirmed: 30,
} as const;

export const SLIPPAGE_CONCERN_CENTS = 5;
export const PREFLIGHT_DRIFT_CONCERN_CENTS = 3;
export const MIDDLE_RATE_GAP_RATIO = 0.6;

export type Tier = "below_preliminary" | "preliminary" | "actionable" | "confirmed";

export type ExecutionFlag =
  | "slippage_concern"
  | "middle_rate_gap"
  | "execution_review"
  | "hold"
  | "insufficient_evidence";

export type LiveBucketStats = {
  sportId: string;
  marketType: string;
  lineFamily: string;
  costBucket: string;
  middleWidth: number;
  comparisonGroup: string;
  resolved: number;
  wins: number;
  losses: number;
  middles: number;
  totalCost: number;
  totalPnl: number;
  capitalWeightedRoiPct: number;
  simpleAvgRoiPct: number;
  winRate: number | null;
  middleRate: number | null;
  firstResolvedAt: string | null;
  lastResolvedAt: string | null;
  tier: Tier;
  enforcedLive: boolean;
  executionFlag: ExecutionFlag;
  /** Avg fill slippage (actual − quoted/preflight) in cents per share. */
  avgFillSlippageCents: number | null;
  /** Avg REST preflight − WS drift in cents (only when executionQuote persisted). */
  avgPreflightDriftCents: number | null;
  slippageSampleCount: number;
  preflightDriftSampleCount: number;
};

export type StrategyBucketsSnapshot = {
  generatedAt: string;
  totalResolvedPackages: number;
  thresholds: typeof TIER_THRESHOLDS;
  buckets: LiveBucketStats[];
  allowlist: StrategyAllowlistSnapshot;
  baseline: BaselineBucket[];
  backtestShapes: BacktestShapeRow[];
};

function classifyTier(resolved: number): Tier {
  if (resolved >= TIER_THRESHOLDS.confirmed) return "confirmed";
  if (resolved >= TIER_THRESHOLDS.actionable) return "actionable";
  if (resolved >= TIER_THRESHOLDS.preliminary) return "preliminary";
  return "below_preliminary";
}

function isEnforcedLive(
  sportId: string,
  marketType: string,
  lineFamily: string,
  costBucket: string,
  middleWidth: number,
  allow: StrategyAllowlistSnapshot,
): boolean {
  if (sportId === "SOCCER") {
    if (!allow.soccer.allowedMarketTypes.includes(marketType)) return false;
    return isSoccerBacktestEnforcedShape(marketType, lineFamily, middleWidth);
  }
  if (sportId === "MLB") {
    if (marketType === "game_total") {
      const range = allow.mlb.gameTotalLineFamilies[lineFamily];
      if (!range) return false;
      return isCostBucketInRange(costBucket, range);
    }
    if (marketType === "spread") {
      if (!allow.mlb.spreadWidthsAllowed.includes(middleWidth)) return false;
      return isCostBucketInRange(costBucket, allow.mlb.spreadCostRange);
    }
    return false;
  }
  return false;
}

function isCostBucketInRange(bucket: string, range: { lo: number; hi: number }): boolean {
  if (bucket === "<1.000") return false;
  if (bucket === ">1.500") return false;
  const [loStr, hiStr] = bucket.split("-");
  const lo = Number(loStr);
  const hi = Number(hiStr);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return false;
  return lo >= range.lo - 1e-6 && hi <= range.hi + 1e-6;
}

export function executionFlagFor(
  stats: Omit<LiveBucketStats, "executionFlag">,
  backtestMiddleRate: number | null,
): ExecutionFlag {
  if (stats.tier === "below_preliminary" || stats.tier === "preliminary") {
    return "insufficient_evidence";
  }
  if (stats.avgFillSlippageCents != null && stats.avgFillSlippageCents >= SLIPPAGE_CONCERN_CENTS) {
    return "slippage_concern";
  }
  if (stats.avgPreflightDriftCents != null && stats.avgPreflightDriftCents >= PREFLIGHT_DRIFT_CONCERN_CENTS) {
    return "slippage_concern";
  }
  if (
    stats.enforcedLive
    && stats.middleRate != null
    && backtestMiddleRate != null
    && backtestMiddleRate > 0
    && stats.middleRate < backtestMiddleRate * MIDDLE_RATE_GAP_RATIO
  ) {
    return "middle_rate_gap";
  }
  if (stats.enforcedLive && stats.capitalWeightedRoiPct < 0 && stats.slippageSampleCount === 0) {
    return "execution_review";
  }
  if (stats.enforcedLive && stats.capitalWeightedRoiPct < 0) {
    return "execution_review";
  }
  return "hold";
}

export function aggregateLiveBuckets(
  packages: SportsArbPackage[],
  allow: StrategyAllowlistSnapshot,
  baseline: BaselineBucket[],
  backtestShapes: BacktestShapeRow[] = [],
): StrategyBucketsSnapshot {
  type Acc = {
    sportId: string;
    marketType: string;
    lineFamily: string;
    costBucket: string;
    middleWidth: number;
    comparisonGroup: string;
    resolved: number;
    wins: number;
    losses: number;
    middles: number;
    totalCost: number;
    totalPnl: number;
    roiSum: number;
    fillSlippageSum: number;
    fillSlippageCount: number;
    preflightDriftSum: number;
    preflightDriftCount: number;
    firstResolvedAt: string | null;
    lastResolvedAt: string | null;
  };

  const backtestMiddleRates = backtestMiddleRateByFamily(backtestShapes);
  const grouped = new Map<string, Acc>();
  let resolvedTotal = 0;
  for (const pkg of packages) {
    if (pkg.resolution?.status !== "resolved") continue;
    resolvedTotal += 1;
    const key = pkg.strategy.comparisonGroup;
    const acc = grouped.get(key) ?? {
      sportId: pkg.sport.sportId,
      marketType: pkg.strategy.marketType,
      lineFamily: pkg.strategy.lineFamily,
      costBucket: pkg.strategy.costBucket,
      middleWidth: pkg.strategy.middleWidth,
      comparisonGroup: key,
      resolved: 0,
      wins: 0,
      losses: 0,
      middles: 0,
      totalCost: 0,
      totalPnl: 0,
      roiSum: 0,
      fillSlippageSum: 0,
      fillSlippageCount: 0,
      preflightDriftSum: 0,
      preflightDriftCount: 0,
      firstResolvedAt: null,
      lastResolvedAt: null,
    };
    const cost = pkg.pricing.packageCost * (pkg.sizing.intendedShares || 1);
    const pnl = pkg.resolution.pnlUsd ?? 0;
    const roi = pkg.resolution.roiPct ?? 0;
    acc.resolved += 1;
    if (roi > 0) acc.wins += 1;
    else acc.losses += 1;
    if ((pkg.resolution.winningTokenIds?.length ?? 0) >= 2) acc.middles += 1;
    acc.totalCost += cost;
    acc.totalPnl += pnl;
    acc.roiSum += roi;
    const fillSlip = pkg.pricing.executionQuote?.fillSlippageCents;
    if (fillSlip != null && Number.isFinite(fillSlip)) {
      acc.fillSlippageSum += fillSlip;
      acc.fillSlippageCount += 1;
    }
    const preflightDrift = pkg.pricing.executionQuote?.preflightDriftCents;
    if (preflightDrift != null && Number.isFinite(preflightDrift)) {
      acc.preflightDriftSum += preflightDrift;
      acc.preflightDriftCount += 1;
    }
    const at = pkg.resolution.resolvedAt ?? pkg.timestamps.updated ?? null;
    if (at) {
      if (!acc.firstResolvedAt || at < acc.firstResolvedAt) acc.firstResolvedAt = at;
      if (!acc.lastResolvedAt || at > acc.lastResolvedAt) acc.lastResolvedAt = at;
    }
    grouped.set(key, acc);
  }

  const buckets: LiveBucketStats[] = [];
  for (const acc of grouped.values()) {
    const tier = classifyTier(acc.resolved);
    const enforced = isEnforcedLive(
      acc.sportId,
      acc.marketType,
      acc.lineFamily,
      acc.costBucket,
      acc.middleWidth,
      allow,
    );
    const capitalRoi = acc.totalCost > 0 ? (acc.totalPnl / acc.totalCost) * 100 : 0;
    const simpleRoi = acc.resolved > 0 ? acc.roiSum / acc.resolved : 0;
    const winRate = acc.resolved > 0 ? acc.wins / acc.resolved : null;
    const middleRate = acc.resolved > 0 ? acc.middles / acc.resolved : null;
    const avgFillSlippageCents = acc.fillSlippageCount > 0
      ? round2(acc.fillSlippageSum / acc.fillSlippageCount)
      : null;
    const avgPreflightDriftCents = acc.preflightDriftCount > 0
      ? round2(acc.preflightDriftSum / acc.preflightDriftCount)
      : null;
    const backtestMiddleRate =
      backtestMiddleRates.get(`${acc.sportId}:${acc.marketType}:${acc.lineFamily}`) ?? null;
    const base = {
      sportId: acc.sportId,
      marketType: acc.marketType,
      lineFamily: acc.lineFamily,
      costBucket: acc.costBucket,
      middleWidth: acc.middleWidth,
      comparisonGroup: acc.comparisonGroup,
      resolved: acc.resolved,
      wins: acc.wins,
      losses: acc.losses,
      middles: acc.middles,
      totalCost: round2(acc.totalCost),
      totalPnl: round2(acc.totalPnl),
      capitalWeightedRoiPct: round2(capitalRoi),
      simpleAvgRoiPct: round2(simpleRoi),
      winRate,
      middleRate,
      firstResolvedAt: acc.firstResolvedAt,
      lastResolvedAt: acc.lastResolvedAt,
      tier,
      enforcedLive: enforced,
      avgFillSlippageCents,
      avgPreflightDriftCents,
      slippageSampleCount: acc.fillSlippageCount,
      preflightDriftSampleCount: acc.preflightDriftCount,
    };
    buckets.push({
      ...base,
      executionFlag: executionFlagFor(base, backtestMiddleRate),
    });
  }
  buckets.sort((a, b) => {
    const rank = (flag: ExecutionFlag) => {
      if (flag === "slippage_concern") return 0;
      if (flag === "middle_rate_gap") return 1;
      if (flag === "execution_review") return 2;
      return 3;
    };
    const delta = rank(a.executionFlag) - rank(b.executionFlag);
    if (delta !== 0) return delta;
    return b.resolved - a.resolved;
  });

  return {
    generatedAt: new Date().toISOString(),
    totalResolvedPackages: resolvedTotal,
    thresholds: TIER_THRESHOLDS,
    buckets,
    allowlist: allow,
    baseline,
    backtestShapes,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

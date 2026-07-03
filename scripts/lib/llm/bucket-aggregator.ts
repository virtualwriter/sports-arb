// Aggregates the daemon's resolved trade ledger (active + archived) into
// per-bucket statistics keyed by (sportId, marketType, lineFamily, costBucket).
// This is the "live evidence" half of the continuous-learning loop; the static
// Jun 16-22 backtest baseline (loadBaselineBuckets) is the other half.
//
// Tiering:
//   preliminary  -> n >= 5   (visible in reports, not actionable)
//   actionable   -> n >= 15  (eligible to be flagged for promote/demote)
//   confirmed    -> n >= 30  (high-confidence signal)
//
// Recommendations are deliberately conservative: a bucket only gets a
// promote_candidate / demote_candidate tag when its sample size has crossed
// `actionable` AND its capital-weighted ROI is meaningfully positive/negative.
// The actual code change (editing sports-strategy.ts constants) is left as a
// manual review step until the live ledger has many more trades per bucket.

import type { SportsArbPackage } from "../types.js";
import type { StrategyAllowlistSnapshot } from "../sports-strategy.js";
import type { BaselineBucket } from "./baseline-evidence.js";

export const TIER_THRESHOLDS = {
  preliminary: 5,
  actionable: 15,
  confirmed: 30,
} as const;

export const PROMOTE_ROI_PCT = 5;
export const DEMOTE_ROI_PCT = -3;

export type Tier = "below_preliminary" | "preliminary" | "actionable" | "confirmed";

export type Recommendation =
  | "promote_candidate"
  | "demote_candidate"
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
  recommendation: Recommendation;
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
    if (marketType !== "match_total") return false;
    if (!allow.soccer.matchTotalLineFamilies.includes(lineFamily)) return false;
    if (!allow.soccer.matchTotalWidthsAllowed.includes(middleWidth)) return false;
    const familyMax = allow.soccer.matchTotalFamilyMaxLiveCost[lineFamily];
    if (familyMax === undefined) return false;
    return isCostBucketInRange(costBucket, { lo: allow.soccer.matchTotalMinLiveCost, hi: familyMax });
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

// Cost buckets use string labels like "1.050-1.100". We treat the bucket as
// "in range" if its lower bound is >= range.lo and its upper bound is <=
// range.hi + tiny epsilon. The "<1.000" bucket is never live-enforced.
function isCostBucketInRange(bucket: string, range: { lo: number; hi: number }): boolean {
  if (bucket === "<1.000") return false;
  if (bucket === ">1.500") return false;
  const [loStr, hiStr] = bucket.split("-");
  const lo = Number(loStr);
  const hi = Number(hiStr);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return false;
  return lo >= range.lo - 1e-6 && hi <= range.hi + 1e-6;
}

function recommendationFor(stats: Omit<LiveBucketStats, "recommendation">): Recommendation {
  if (stats.tier === "below_preliminary" || stats.tier === "preliminary") {
    return "insufficient_evidence";
  }
  if (stats.enforcedLive && stats.capitalWeightedRoiPct <= DEMOTE_ROI_PCT) {
    return "demote_candidate";
  }
  if (!stats.enforcedLive && stats.capitalWeightedRoiPct >= PROMOTE_ROI_PCT) {
    return "promote_candidate";
  }
  return "hold";
}

export function aggregateLiveBuckets(
  packages: SportsArbPackage[],
  allow: StrategyAllowlistSnapshot,
  baseline: BaselineBucket[],
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
    // Both legs winning => true middle. Single-token win is a floor (1x).
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
    buckets.push({ ...base, recommendation: recommendationFor(base) });
  }
  buckets.sort((a, b) => {
    if (a.recommendation === "demote_candidate" && b.recommendation !== "demote_candidate") return -1;
    if (b.recommendation === "demote_candidate" && a.recommendation !== "demote_candidate") return 1;
    if (a.recommendation === "promote_candidate" && b.recommendation !== "promote_candidate") return -1;
    if (b.recommendation === "promote_candidate" && a.recommendation !== "promote_candidate") return 1;
    return b.resolved - a.resolved;
  });

  return {
    generatedAt: new Date().toISOString(),
    totalResolvedPackages: resolvedTotal,
    thresholds: TIER_THRESHOLDS,
    buckets,
    allowlist: allow,
    baseline,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

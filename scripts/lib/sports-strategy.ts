import type { Candidate } from "./monotonic-arb-core.js";
import { adapterForCandidate, type SportAdapter } from "./sports-registry.js";
import type { MarketType, ShadowPurpose } from "./types.js";

export type StrategyDecision = {
  adapter: SportAdapter | null;
  marketType: MarketType;
  lineFamily: string;
  middleWidth: number;
  costBucket: string;
  comparisonGroup: string;
  liveEligible: boolean;
  shadowEligible: boolean;
  shadowPurpose?: ShadowPurpose;
  gateFailures: string[];
};

export function costBucket(cost: number): string {
  if (cost < 1) return "<1.000";
  if (cost <= 1.005) return "1.000-1.005";
  if (cost <= 1.02) return "1.005-1.020";
  if (cost <= 1.05) return "1.020-1.050";
  if (cost <= 1.10) return "1.050-1.100";
  if (cost <= 1.16) return "1.100-1.160";
  if (cost <= 1.19) return "1.160-1.190";
  if (cost <= 1.22) return "1.190-1.220";
  if (cost <= 1.25) return "1.220-1.250";
  if (cost <= 1.35) return "1.250-1.350";
  if (cost <= 1.50) return "1.350-1.500";
  return ">1.500";
}

function within(cost: number, lo: number, hi: number): boolean {
  return cost >= lo && cost <= hi;
}

function normalizeLineFamily(candidate: Candidate): string {
  return `${candidate.broad.strike}-${candidate.narrow.strike}`;
}

function middleWidth(candidate: Candidate): number {
  return Math.abs(candidate.narrow.strike - candidate.broad.strike);
}

const SPORTS_MAX_ENTRY_LEG_PRICE = Number(process.env.ARB_DAEMON_SPORTS_MAX_ENTRY_LEG_PRICE ?? 0.98);
const SOCCER_MIN_NARROW_YES_BID = Number(process.env.ARB_DAEMON_SOCCER_MIN_NARROW_YES_BID ?? 0.02);
// Shape-aware relax: per per-line-family audit (n=8-24 per shape), narrow legs at
// 5.5+ goals on match totals are systematically sold cheap (2.5/5.5 historical
// 33.3% middle hit vs 26.6% market-implied at our last trade; 3.5/6.5 deep-blocked
// subset +3.4% EV). Other shapes (spreads, halftime totals, 3.5/5.5) showed the
// 0.02 floor was correctly filtering zero-hit traps, so they keep the strict bid.
const SOCCER_RELAXED_MIN_NARROW_YES_BID = Number(
  process.env.ARB_DAEMON_SOCCER_RELAXED_MIN_NARROW_YES_BID ?? 0.015,
);
const SOCCER_MAX_NARROW_YES_BID = Number(process.env.ARB_DAEMON_SOCCER_MAX_NARROW_YES_BID ?? 0.10);
const MLB_MIN_NARROW_YES_BID = Number(process.env.ARB_DAEMON_MLB_MIN_NARROW_YES_BID ?? 0.30);

function maxEntryLeg(candidate: Candidate): number {
  return Math.max(candidate.broad.yesBook.ask, candidate.narrow.noBook.ask);
}

function impliedNarrowYesBid(candidate: Candidate): number {
  return Math.max(0, Math.min(1, 1 - candidate.narrow.noBook.ask));
}

// `2.5-6.5` is a width-4 match-total middle (goals in {3,4,5,6}). Doc evidence:
// 4-goal middles +17.9% ROI (n=34) at avg cost $1.17, and the `2.5-6.5` family
// itself +13.7% ROI (n=20). Live scanning shows costs $1.11-$1.25 with narrow
// NO well below 0.98, so the strict-NYB floor and the 0.98 leg cap apply normally.
const SOCCER_MATCH_TOTAL_LINE_FAMILIES = new Set(["2.5-4.5", "2.5-5.5", "2.5-6.5", "3.5-5.5", "3.5-6.5"]);
const SOCCER_MATCH_TOTAL_WIDTH_ALLOW = new Set([2, 3, 4]);
// Subset of allowed match-total families that may use the relaxed narrow-bid floor.
// Picked deliberately from audit evidence; do NOT widen without a fresh pull.
const SOCCER_MATCH_TOTAL_RELAXED_NYB_FAMILIES = new Set(["2.5-5.5", "3.5-6.5"]);
// Live ledger Jun25+: 3.5/6.5 at ~$1.28 averaged 6.7% middle hit vs 45% backtest @
// $1.17; 2.5/4.5 T3 fills @ ~$1.31 also underperformed. Cap each family to the
// backtest-evidence cost ceiling so T3 band permission does not override shape ROI.
const SOCCER_MATCH_TOTAL_FAMILY_MAX_LIVE_COST = new Map<string, number>([
  ["3.5-6.5", Number(process.env.ARB_DAEMON_SOCCER_MAX_COST_3_5_6_5 ?? 1.20)],
  ["2.5-4.5", Number(process.env.ARB_DAEMON_SOCCER_MAX_COST_2_5_4_5 ?? 1.22)],
]);
const SOCCER_SPREAD_BROAD_MIN = 1.5;
const SOCCER_SPREAD_BROAD_MAX = 3.5;
const MLB_GAME_TOTAL_LIVE_COST_RANGES = new Map<string, { lo: number; hi: number }>([
  ["5.5-7.5", { lo: 1.19, hi: 1.22 }],
  ["6.5-7.5", { lo: 1.10, hi: 1.16 }],
  ["6.5-8.5", { lo: 1.16, hi: 1.19 }],
]);

function isFullGameMatchTotal(candidate: Candidate): boolean {
  return candidate.broad.ladderKey.includes(":total:full-game")
    && candidate.narrow.ladderKey.includes(":total:full-game");
}

function isFullGameSpread(candidate: Candidate): boolean {
  return candidate.broad.ladderKey.includes(":spread:full-game")
    && candidate.narrow.ladderKey.includes(":spread:full-game");
}

/**
 * Shape-aware soccer narrow-yes-bid floor. Returns the relaxed (looser) floor
 * only for full-game match-total families with empirical evidence that the
 * narrow leg is systematically sold cheap. Everything else (spreads, halftime
 * totals, narrow shapes 1.5/2.5, 3.5/5.5, etc.) keeps the strict default.
 */
export function soccerEffectiveMinNarrowYesBid(candidate: Candidate): number {
  if (!isFullGameMatchTotal(candidate)) return SOCCER_MIN_NARROW_YES_BID;
  const family = normalizeLineFamily(candidate);
  if (!SOCCER_MATCH_TOTAL_RELAXED_NYB_FAMILIES.has(family)) return SOCCER_MIN_NARROW_YES_BID;
  return Math.min(SOCCER_MIN_NARROW_YES_BID, SOCCER_RELAXED_MIN_NARROW_YES_BID);
}

/**
 * Shape-aware max-entry-leg cap. The narrow-leg cap and the narrow-yes-bid
 * floor are mathematically the same constraint (narrow YES bid >= X iff
 * narrow NO ask <= 1 - X). When we relax the floor for a shape, we MUST
 * relax the leg cap by the matching amount or the two gates shadow each
 * other and collapse back to the strict bid floor.
 *
 * Note: the bump also applies to the broad-leg side of the max(), but
 * broad asks for the relaxed shapes (2.5-5.5, 3.5-6.5) are always
 * $0.05-$0.29 -- nowhere near 0.98 -- so the spillover is harmless.
 */
export function sportsEffectiveMaxEntryLegPrice(candidate: Candidate, defaultCap: number): number {
  if (candidate.asset !== "SOCCER") return defaultCap;
  const minBid = soccerEffectiveMinNarrowYesBid(candidate);
  if (minBid >= SOCCER_MIN_NARROW_YES_BID) return defaultCap;
  // Bid floor uses `bid < floor` semantics so bid = floor exactly passes.
  // The leg cap downstream uses `ask + EPS >= cap` semantics, which would
  // reject ask = 1 - floor at the boundary. Add a 0.001 tick-aware buffer
  // (Polymarket books trade in 1c ticks) so the two checks are symmetric.
  return Math.max(defaultCap, 1 - minBid + 0.001);
}

function soccerLive(candidate: Candidate, marketType: MarketType): string[] {
  const failures: string[] = [];
  const cost = candidate.packageCost;
  const family = normalizeLineFamily(candidate);
  const width = middleWidth(candidate);
  const narrowYesBid = impliedNarrowYesBid(candidate);
  const allowedCost = within(cost, 1.05, 1.22) || (within(cost, 1.25, 1.35) && marketType === "match_total");
  if (!allowedCost && cost >= 1) failures.push("soccer_cost_bucket_not_live");
  if (!(marketType === "match_total" || marketType === "spread")) failures.push("soccer_market_shape_not_live");
  if (marketType === "match_total") {
    if (!isFullGameMatchTotal(candidate)) failures.push("soccer_total_not_full_game");
    if (!SOCCER_MATCH_TOTAL_WIDTH_ALLOW.has(width)) failures.push("soccer_total_width_not_historical_winner");
    if (!SOCCER_MATCH_TOTAL_LINE_FAMILIES.has(family)) failures.push("soccer_total_line_family_not_historical_winner");
    const familyMaxCost = SOCCER_MATCH_TOTAL_FAMILY_MAX_LIVE_COST.get(family);
    if (familyMaxCost !== undefined && cost >= 1 && cost > familyMaxCost + 1e-9) {
      failures.push("soccer_total_family_max_cost_exceeded");
    }
  }
  if (marketType === "spread") {
    if (!isFullGameSpread(candidate)) failures.push("soccer_spread_not_full_game");
    if (!(width === 2 || width === 3)) failures.push("soccer_spread_width_not_historical_winner");
    if (!(candidate.broad.strike >= SOCCER_SPREAD_BROAD_MIN && candidate.broad.strike <= SOCCER_SPREAD_BROAD_MAX)) {
      failures.push("soccer_spread_line_family_not_historical_winner");
    }
  }
  const soccerLegCap = sportsEffectiveMaxEntryLegPrice(candidate, SPORTS_MAX_ENTRY_LEG_PRICE);
  if (soccerLegCap > 0 && maxEntryLeg(candidate) >= soccerLegCap) {
    failures.push("soccer_max_entry_leg_price_exceeded");
  }
  const minNarrowYesBid = soccerEffectiveMinNarrowYesBid(candidate);
  if (minNarrowYesBid > 0 && narrowYesBid < minNarrowYesBid) {
    failures.push("soccer_narrow_yes_bid_too_low");
  }
  if (SOCCER_MAX_NARROW_YES_BID > 0 && narrowYesBid > SOCCER_MAX_NARROW_YES_BID) {
    failures.push("soccer_narrow_yes_bid_too_high");
  }
  return failures;
}

function mlbLive(candidate: Candidate, marketType: MarketType): string[] {
  const failures: string[] = [];
  const cost = candidate.packageCost;
  const family = normalizeLineFamily(candidate);
  const width = middleWidth(candidate);
  const narrowYesBid = impliedNarrowYesBid(candidate);
  if (!(marketType === "game_total" || marketType === "spread")) failures.push("mlb_market_shape_not_live");
  if (marketType === "game_total") {
    const liveCostRange = MLB_GAME_TOTAL_LIVE_COST_RANGES.get(family);
    if (!liveCostRange) {
      failures.push("mlb_total_line_family_not_preferred");
    } else if (cost >= 1 && !within(cost, liveCostRange.lo, liveCostRange.hi)) {
      failures.push("mlb_cost_bucket_not_live");
    }
  }
  if (marketType === "spread") {
    if (!within(cost, 1.19, 1.22) && cost >= 1) failures.push("mlb_cost_bucket_not_live");
    if (width !== 1) failures.push("mlb_spread_width_not_preferred");
  }
  if (SPORTS_MAX_ENTRY_LEG_PRICE > 0 && maxEntryLeg(candidate) >= SPORTS_MAX_ENTRY_LEG_PRICE) {
    failures.push("mlb_max_entry_leg_price_exceeded");
  }
  if (MLB_MIN_NARROW_YES_BID > 0 && narrowYesBid < MLB_MIN_NARROW_YES_BID) {
    failures.push("mlb_narrow_yes_bid_too_low");
  }
  return failures;
}

function nonPrimaryLive(adapter: SportAdapter | null): string[] {
  if (!adapter) return ["unsupported_sport"];
  if (adapter.mode === "discovery_only") return ["adapter_discovery_only"];
  if (adapter.mode === "shadow_only") return ["adapter_shadow_only"];
  return [];
}

function shadowPurpose(candidate: Candidate, gateFailures: string[]): ShadowPurpose | undefined {
  if (candidate.packageCost < 1) return "sub_1_universal_capture";
  if (gateFailures.some((failure) => failure.includes("cost_bucket"))) return "excluded_cost_bucket_probe";
  if (gateFailures.some((failure) => failure.includes("shape") || failure.includes("family") || failure.includes("width"))) return "excluded_shape_probe";
  if (gateFailures.length > 0) return "near_live_cut";
  if (!candidate.eligible || candidate.rejectionReasons.length > 0) return "operational_reject";
  return undefined;
}

/**
 * Snapshot of the hardcoded strategy gate. The LLM learning pass and the
 * nightly strategy-bucket aggregator both read this so they can compare the
 * currently-enforced allowlist against the freshest live evidence and the
 * frozen baseline. Keep this function in lockstep with the const sets above
 * (or, when we eventually drive the gate from a config file, this snapshot
 * becomes the loader's return value).
 */
export type StrategyAllowlistSnapshot = {
  generatedAt: string;
  soccer: {
    costRangeLive: { lo: number; hi: number };
    costRangeMatchTotalExtended: { lo: number; hi: number };
    matchTotalLineFamilies: string[];
    matchTotalRelaxedNybFamilies: string[];
    matchTotalFamilyMaxLiveCost: Record<string, number>;
    matchTotalWidthsAllowed: number[];
    spreadBroadStrike: { lo: number; hi: number };
    spreadWidthsAllowed: number[];
    minNarrowYesBid: number;
    relaxedMinNarrowYesBid: number;
    maxNarrowYesBid: number;
    maxEntryLegPrice: number;
  };
  mlb: {
    gameTotalLineFamilies: Record<string, { lo: number; hi: number }>;
    spreadCostRange: { lo: number; hi: number };
    spreadWidthsAllowed: number[];
    minNarrowYesBid: number;
    maxEntryLegPrice: number;
  };
};

export function currentStrategyAllowlist(): StrategyAllowlistSnapshot {
  const mlbGameTotals: Record<string, { lo: number; hi: number }> = {};
  for (const [family, range] of MLB_GAME_TOTAL_LIVE_COST_RANGES.entries()) {
    mlbGameTotals[family] = { lo: range.lo, hi: range.hi };
  }
  return {
    generatedAt: new Date().toISOString(),
    soccer: {
      costRangeLive: { lo: 1.05, hi: 1.22 },
      costRangeMatchTotalExtended: { lo: 1.25, hi: 1.35 },
      matchTotalLineFamilies: [...SOCCER_MATCH_TOTAL_LINE_FAMILIES],
      matchTotalRelaxedNybFamilies: [...SOCCER_MATCH_TOTAL_RELAXED_NYB_FAMILIES],
      matchTotalFamilyMaxLiveCost: Object.fromEntries(SOCCER_MATCH_TOTAL_FAMILY_MAX_LIVE_COST.entries()),
      matchTotalWidthsAllowed: [...SOCCER_MATCH_TOTAL_WIDTH_ALLOW],
      spreadBroadStrike: { lo: SOCCER_SPREAD_BROAD_MIN, hi: SOCCER_SPREAD_BROAD_MAX },
      spreadWidthsAllowed: [2, 3],
      minNarrowYesBid: SOCCER_MIN_NARROW_YES_BID,
      relaxedMinNarrowYesBid: SOCCER_RELAXED_MIN_NARROW_YES_BID,
      maxNarrowYesBid: SOCCER_MAX_NARROW_YES_BID,
      maxEntryLegPrice: SPORTS_MAX_ENTRY_LEG_PRICE,
    },
    mlb: {
      gameTotalLineFamilies: mlbGameTotals,
      spreadCostRange: { lo: 1.19, hi: 1.22 },
      spreadWidthsAllowed: [1],
      minNarrowYesBid: MLB_MIN_NARROW_YES_BID,
      maxEntryLegPrice: SPORTS_MAX_ENTRY_LEG_PRICE,
    },
  };
}

export function evaluateSportsStrategy(candidate: Candidate): StrategyDecision {
  const adapter = adapterForCandidate(candidate);
  const marketType = adapter?.classifyMarket(candidate.broad) ?? "unknown";
  const lineFamily = adapter?.lineFamily(candidate) ?? normalizeLineFamily(candidate);
  const width = middleWidth(candidate);
  const bucket = costBucket(candidate.packageCost);
  const gateFailures: string[] = [];

  if (!adapter) {
    gateFailures.push("unsupported_sport");
  } else if (adapter.sportId === "SOCCER") {
    gateFailures.push(...soccerLive(candidate, marketType));
  } else if (adapter.sportId === "MLB") {
    gateFailures.push(...mlbLive(candidate, marketType));
  } else {
    gateFailures.push(...nonPrimaryLive(adapter));
  }

  if (!candidate.eligible) gateFailures.push(...candidate.rejectionReasons);

  const purpose = shadowPurpose(candidate, gateFailures);
  const liveEligible = gateFailures.length === 0 && adapter?.mode === "live_enabled";
  const shadowEligible = Boolean(purpose);

  return {
    adapter,
    marketType,
    lineFamily,
    middleWidth: width,
    costBucket: bucket,
    comparisonGroup: `${adapter?.sportId ?? "UNKNOWN"}:${marketType}:${lineFamily}:${bucket}`,
    liveEligible,
    shadowEligible,
    shadowPurpose: purpose,
    gateFailures,
  };
}

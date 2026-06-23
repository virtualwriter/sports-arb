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
const SOCCER_MAX_NARROW_YES_BID = Number(process.env.ARB_DAEMON_SOCCER_MAX_NARROW_YES_BID ?? 0.10);
const MLB_MIN_NARROW_YES_BID = Number(process.env.ARB_DAEMON_MLB_MIN_NARROW_YES_BID ?? 0.30);

function maxEntryLeg(candidate: Candidate): number {
  return Math.max(candidate.broad.yesBook.ask, candidate.narrow.noBook.ask);
}

function impliedNarrowYesBid(candidate: Candidate): number {
  return Math.max(0, Math.min(1, 1 - candidate.narrow.noBook.ask));
}

function soccerLive(candidate: Candidate, marketType: MarketType): string[] {
  const failures: string[] = [];
  const cost = candidate.packageCost;
  const width = middleWidth(candidate);
  const narrowYesBid = impliedNarrowYesBid(candidate);
  const allowedCost = within(cost, 1.05, 1.22) || (within(cost, 1.25, 1.35) && (marketType === "match_total" || marketType === "spread"));
  if (!allowedCost && cost >= 1) failures.push("soccer_cost_bucket_not_live");
  if (!(marketType === "match_total" || marketType === "spread")) failures.push("soccer_market_shape_not_live");
  if (marketType === "spread" && !(width >= 1 && width <= 3)) failures.push("soccer_spread_width_not_preferred");
  if (marketType === "match_total" && !(width >= 1 && width <= 5)) failures.push("soccer_total_width_not_preferred");
  if (SPORTS_MAX_ENTRY_LEG_PRICE > 0 && maxEntryLeg(candidate) >= SPORTS_MAX_ENTRY_LEG_PRICE) {
    failures.push("soccer_max_entry_leg_price_exceeded");
  }
  if (SOCCER_MIN_NARROW_YES_BID > 0 && narrowYesBid < SOCCER_MIN_NARROW_YES_BID) {
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
  const preferredTotals = new Set(["5.5-7.5", "5.5-8.5", "6.5-7.5", "6.5-8.5"]);
  if (!within(cost, 1.19, 1.22) && cost >= 1) failures.push("mlb_cost_bucket_not_live");
  if (!(marketType === "game_total" || marketType === "spread")) failures.push("mlb_market_shape_not_live");
  if (marketType === "game_total" && !preferredTotals.has(family)) failures.push("mlb_total_line_family_not_preferred");
  if (marketType === "spread" && width !== 1) failures.push("mlb_spread_width_not_preferred");
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

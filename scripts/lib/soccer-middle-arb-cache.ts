/**
 * Per-event cache for soccer middle-arb shock lane.
 *
 * Precomputes allowlisted packages with:
 *   - execution tokens (WS TOB / FAK without REST)
 *   - cost bands (scan band + shape maxLiveCost + leg caps)
 *   - T+1 counterfactuals: total+1 (match_total) and each team+1 (spreads)
 *
 * Rebuild structural entries when the watchlist refreshes; refresh `state`
 * whenever score / clock updates. At ML shock, read WS asks and evaluate.
 *
 * Depends on soccer-middle-arb-filters + backtest shape allowlist. Not daemon-wired.
 */

import type { Candidate } from "./monotonic-arb-core.js";
import {
  backtestLineFamily,
  backtestMiddleWidth,
  backtestShapeKey,
  loadSportsBacktestPositiveShapes,
  type SportsBacktestShape,
} from "./soccer-backtest-live-gate.js";
import {
  COST_HI,
  COST_LO,
  MAX_ENTRY_LEG_PRICE,
  MAX_NARROW_YES_BID,
  MIN_NARROW_YES_BID,
  SOCCER_MIDDLE_ARB_FILTERS_VERSION,
  screenSoccerMiddleArb,
  type SoccerMiddleArbFilterResult,
} from "./soccer-middle-arb-filters.js";
import {
  poissonDiffPInBand,
  poissonPInBand,
  resolveSpreadSide,
  spreadTeamKeyFromLadder,
  teamKeyFromName,
} from "./strat2-mlb-live-gate.js";
import type { MarketType } from "./types.js";

export const SOCCER_MIDDLE_ARB_CACHE_VERSION = "2026-07-15.1";

/** Goals / minute prior used in ENG–ARG scans (2.6 / 90). */
export const SOCCER_GOALS_PER_MINUTE = 2.6 / 90;

export type SoccerT1Branch =
  | { kind: "total_plus_1" }
  | { kind: "team_plus_1"; teamKey: string };

export type SoccerMiddleArbCostBands = {
  /** Shock-lane opportunity band (filters). */
  scanLo: number;
  scanHi: number;
  /** Shape allowlist live cap (EV-margin). */
  maxLiveCost: number;
  worstAvgCost: number;
  middleRate: number;
  maxEntryLegPrice: number;
  minNarrowYesBid: number;
  maxNarrowYesBid: number;
};

export type SoccerMiddleArbPackageState = {
  scoreHome: number;
  scoreAway: number;
  minsLeft: number;
  lambda: number;
  /** P(middle) at current score. */
  pCurrent: number;
  /** Totals: P after +1 goal (either team). */
  pTotalPlus1: number;
  /** Spreads: P if home (title side) scores; equals pCurrent for totals. */
  pHomePlus1: number;
  /** Spreads: P if away (title side) scores; equals pTotalPlus1 for totals. */
  pAwayPlus1: number;
  /** Per spread-team key → P after that team scores. */
  pByScorer: Record<string, number>;
  fairCurrent: number;
  fairTotalPlus1: number;
  updatedAt: number;
};

export type SoccerMiddleArbCachedPackage = {
  packageId: string;
  eventSlug: string;
  marketType: "match_total" | "spread";
  lineFamily: string;
  middleWidth: number;
  shapeKey: string;
  ladderKey: string;
  direction: Candidate["direction"];

  broadMarketId: string;
  narrowMarketId: string;
  broadStrike: number;
  narrowStrike: number;
  /** Signed band for P(middle): totals (lo, hi]; spreads margin (lo, hi]. */
  bandLo: number;
  bandHi: number;

  broadYesTokenId: string;
  narrowNoTokenId: string;
  narrowYesTokenId: string;

  spreadTeamKey: string | null;
  /** Title-relative side for the named spread team. */
  spreadSide: "home" | "away" | null;

  costBands: SoccerMiddleArbCostBands;
  state: SoccerMiddleArbPackageState;
};

export type SoccerMiddleArbMlTokens = {
  homeYesTokenId?: string;
  awayYesTokenId?: string;
  drawYesTokenId?: string;
  /** ladderKey / market → yes token for shock attribution */
  byTeamKey: Record<string, string>;
};

export type SoccerMiddleArbEventCache = {
  version: string;
  filtersVersion: string;
  eventSlug: string;
  eventTitle: string;
  /** From "Away vs. Home" title parse (Polymarket convention). */
  awayTeamKey: string | null;
  homeTeamKey: string | null;
  mlTokens: SoccerMiddleArbMlTokens;
  packages: SoccerMiddleArbCachedPackage[];
  builtAt: number;
  stateUpdatedAt: number;
};

export type SoccerMiddleArbLiveTob = {
  broadYesAsk: number;
  narrowNoAsk: number;
  broadYesAskSize?: number;
  narrowNoAskSize?: number;
};

export type SoccerMiddleArbEvalHit = {
  pkg: SoccerMiddleArbCachedPackage;
  branch: SoccerT1Branch;
  cost: number;
  size: number;
  pCurrent: number;
  pTPlus1: number;
  edgeAtCurrent: number;
  edgeAtTPlus1: number;
  screen: SoccerMiddleArbFilterResult;
};

function parseTeamKeysFromTitle(eventTitle: string): {
  awayTeamKey: string | null;
  homeTeamKey: string | null;
} {
  const m = eventTitle.match(/^(.+?)\s+vs\.?\s+(.+?)(?:\s*:.*)?$/i);
  if (!m) return { awayTeamKey: null, homeTeamKey: null };
  return {
    awayTeamKey: teamKeyFromName(m[1]!.trim()),
    homeTeamKey: teamKeyFromName(m[2]!.trim()),
  };
}

/** Parse backtest lineFamily into signed (lo, hi). */
export function parseBacktestLineFamily(
  lineFamily: string,
  marketType: "match_total" | "spread",
): { lo: number; hi: number } {
  if (marketType === "spread" || lineFamily.startsWith("-")) {
    const nums = lineFamily.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    if (nums.length < 2) throw new Error(`bad spread family ${lineFamily}`);
    return { lo: nums[0]!, hi: nums[1]! };
  }
  const [a, b] = lineFamily.split("-", 2);
  return { lo: Number(a), hi: Number(b) };
}

export function soccerMinsLeftFromTimerSeconds(seconds: number | null | undefined): number {
  if (seconds == null || !Number.isFinite(seconds)) return 10;
  const m = seconds / 60;
  const left = Math.max(0, 90 - m);
  if (m >= 85) return left < 3 ? Math.max(left, 3) : left + 2;
  return left + 1;
}

function classifySoccerMarketType(candidate: Candidate): "match_total" | "spread" | null {
  const key = candidate.broad.ladderKey.toLowerCase();
  if (key.includes(":spread:")) return "spread";
  if (key.includes(":total:")) return "match_total";
  return null;
}

function computePackageState(input: {
  marketType: "match_total" | "spread";
  bandLo: number;
  bandHi: number;
  spreadSide: "home" | "away" | null;
  spreadTeamKey: string | null;
  scoreHome: number;
  scoreAway: number;
  minsLeft: number;
  homeTeamKey: string | null;
  awayTeamKey: string | null;
}): SoccerMiddleArbPackageState {
  const minsLeft = Math.max(0, input.minsLeft);
  const lambda = SOCCER_GOALS_PER_MINUTE * minsLeft;
  const total = input.scoreHome + input.scoreAway;
  const now = Date.now();

  if (input.marketType === "match_total") {
    const pCurrent = poissonPInBand(total, input.bandLo, input.bandHi, lambda);
    const pTotalPlus1 = poissonPInBand(total + 1, input.bandLo, input.bandHi, lambda);
    return {
      scoreHome: input.scoreHome,
      scoreAway: input.scoreAway,
      minsLeft,
      lambda,
      pCurrent,
      pTotalPlus1,
      pHomePlus1: pTotalPlus1,
      pAwayPlus1: pTotalPlus1,
      pByScorer: {},
      fairCurrent: 1 + pCurrent,
      fairTotalPlus1: 1 + pTotalPlus1,
      updatedAt: now,
    };
  }

  // Spreads: named-team margin; ±1 goal branches for home/away (title) and team keys.
  const lamTeam = lambda / 2;
  const lamOpp = lambda / 2;
  const side = input.spreadSide ?? "home";
  const margin = side === "home"
    ? input.scoreHome - input.scoreAway
    : input.scoreAway - input.scoreHome;

  const pCurrent = poissonDiffPInBand(margin, input.bandLo, input.bandHi, lamTeam, lamOpp);

  // If home scores: home+1. Named-team margin moves +1 if side=home, else -1.
  const marginHomeScores = side === "home" ? margin + 1 : margin - 1;
  const marginAwayScores = side === "home" ? margin - 1 : margin + 1;
  const pHomePlus1 = poissonDiffPInBand(marginHomeScores, input.bandLo, input.bandHi, lamTeam, lamOpp);
  const pAwayPlus1 = poissonDiffPInBand(marginAwayScores, input.bandLo, input.bandHi, lamTeam, lamOpp);

  const pByScorer: Record<string, number> = {};
  if (input.homeTeamKey) pByScorer[input.homeTeamKey] = pHomePlus1;
  if (input.awayTeamKey) pByScorer[input.awayTeamKey] = pAwayPlus1;
  if (input.spreadTeamKey) {
    // Named team scores → margin +1 for that package's side.
    pByScorer[input.spreadTeamKey] = poissonDiffPInBand(
      margin + 1,
      input.bandLo,
      input.bandHi,
      lamTeam,
      lamOpp,
    );
    // Opponent scores → margin -1
    const oppKey =
      input.spreadSide === "home" ? input.awayTeamKey : input.homeTeamKey;
    if (oppKey) {
      pByScorer[oppKey] = poissonDiffPInBand(
        margin - 1,
        input.bandLo,
        input.bandHi,
        lamTeam,
        lamOpp,
      );
    }
  }

  return {
    scoreHome: input.scoreHome,
    scoreAway: input.scoreAway,
    minsLeft,
    lambda,
    pCurrent,
    pTotalPlus1: pCurrent, // unused for spreads; keep defined
    pHomePlus1,
    pAwayPlus1,
    pByScorer,
    fairCurrent: 1 + pCurrent,
    fairTotalPlus1: 1 + Math.max(pHomePlus1, pAwayPlus1),
    updatedAt: now,
  };
}

function resolveBranchP(
  cache: Pick<SoccerMiddleArbEventCache, "homeTeamKey" | "awayTeamKey">,
  pkg: SoccerMiddleArbCachedPackage,
  branch: SoccerT1Branch,
): number {
  if (pkg.marketType === "match_total" || branch.kind === "total_plus_1") {
    return pkg.state.pTotalPlus1;
  }
  const direct = pkg.state.pByScorer[branch.teamKey];
  if (direct != null) return direct;
  if (cache.homeTeamKey && branch.teamKey === cache.homeTeamKey) return pkg.state.pHomePlus1;
  if (cache.awayTeamKey && branch.teamKey === cache.awayTeamKey) return pkg.state.pAwayPlus1;
  return Math.max(pkg.state.pHomePlus1, pkg.state.pAwayPlus1);
}

export type BuildSoccerMiddleArbEventCacheInput = {
  eventSlug: string;
  eventTitle: string;
  candidates: Candidate[];
  scoreHome: number;
  scoreAway: number;
  minsLeft: number;
  shapes?: Map<string, SportsBacktestShape>;
  mlTokens?: Partial<SoccerMiddleArbMlTokens>;
};

/**
 * Build event cache from structural candidates (watchlist), retaining only
 * allowlisted soccer match_total / spread shapes.
 */
export function buildSoccerMiddleArbEventCache(
  input: BuildSoccerMiddleArbEventCacheInput,
): SoccerMiddleArbEventCache {
  const shapes = input.shapes ?? loadSportsBacktestPositiveShapes();
  const { awayTeamKey, homeTeamKey } = parseTeamKeysFromTitle(input.eventTitle);
  const packages: SoccerMiddleArbCachedPackage[] = [];

  for (const candidate of input.candidates) {
    if (candidate.asset !== "SOCCER" && candidate.asset !== "soccer") continue;
    if (candidate.eventSlug !== input.eventSlug) continue;
    const marketType = classifySoccerMarketType(candidate);
    if (!marketType) continue;

    const lineFamily = backtestLineFamily(candidate, marketType as MarketType);
    const middleWidth = backtestMiddleWidth(candidate);
    const shapeKey = backtestShapeKey("SOCCER", marketType, lineFamily, middleWidth);
    const shape = shapes.get(shapeKey);
    if (!shape) continue;

    // P(middle) bands: totals use signed family; spreads use positive magnitudes
    // so poissonDiffPInBand matches (lo, hi] on named-team margin.
    const parsed = parseBacktestLineFamily(lineFamily, marketType);
    const bandLo =
      marketType === "spread"
        ? Math.min(candidate.broad.strike, candidate.narrow.strike)
        : parsed.lo;
    const bandHi =
      marketType === "spread"
        ? Math.max(candidate.broad.strike, candidate.narrow.strike)
        : parsed.hi;
    const spreadTeamKey =
      marketType === "spread" ? spreadTeamKeyFromLadder(candidate.broad.ladderKey) : null;
    const spreadSide =
      marketType === "spread"
        ? resolveSpreadSide(input.eventTitle, candidate.broad.ladderKey)
        : null;

    const costBands: SoccerMiddleArbCostBands = {
      scanLo: COST_LO,
      scanHi: COST_HI,
      maxLiveCost: shape.maxLiveCost,
      worstAvgCost: shape.worstAvgCost,
      middleRate: shape.middleRate,
      maxEntryLegPrice: MAX_ENTRY_LEG_PRICE,
      minNarrowYesBid: MIN_NARROW_YES_BID,
      maxNarrowYesBid: MAX_NARROW_YES_BID,
    };

    const state = computePackageState({
      marketType,
      bandLo,
      bandHi,
      spreadSide,
      spreadTeamKey,
      scoreHome: input.scoreHome,
      scoreAway: input.scoreAway,
      minsLeft: input.minsLeft,
      homeTeamKey,
      awayTeamKey,
    });

    packages.push({
      packageId: candidate.packageId,
      eventSlug: input.eventSlug,
      marketType,
      lineFamily,
      middleWidth,
      shapeKey,
      ladderKey: candidate.broad.ladderKey,
      direction: candidate.direction,
      broadMarketId: candidate.broad.marketId,
      narrowMarketId: candidate.narrow.marketId,
      broadStrike: candidate.broad.strike,
      narrowStrike: candidate.narrow.strike,
      bandLo,
      bandHi,
      broadYesTokenId: candidate.broad.yesTokenId,
      narrowNoTokenId: candidate.narrow.noTokenId,
      narrowYesTokenId: candidate.narrow.yesTokenId,
      spreadTeamKey,
      spreadSide,
      costBands,
      state,
    });
  }

  packages.sort((a, b) => a.shapeKey.localeCompare(b.shapeKey) || a.packageId.localeCompare(b.packageId));

  const mlTokens: SoccerMiddleArbMlTokens = {
    homeYesTokenId: input.mlTokens?.homeYesTokenId,
    awayYesTokenId: input.mlTokens?.awayYesTokenId,
    drawYesTokenId: input.mlTokens?.drawYesTokenId,
    byTeamKey: { ...(input.mlTokens?.byTeamKey ?? {}) },
  };
  if (homeTeamKey && mlTokens.homeYesTokenId) mlTokens.byTeamKey[homeTeamKey] = mlTokens.homeYesTokenId;
  if (awayTeamKey && mlTokens.awayYesTokenId) mlTokens.byTeamKey[awayTeamKey] = mlTokens.awayYesTokenId;

  const now = Date.now();
  return {
    version: SOCCER_MIDDLE_ARB_CACHE_VERSION,
    filtersVersion: SOCCER_MIDDLE_ARB_FILTERS_VERSION,
    eventSlug: input.eventSlug,
    eventTitle: input.eventTitle,
    awayTeamKey,
    homeTeamKey,
    mlTokens,
    packages,
    builtAt: now,
    stateUpdatedAt: now,
  };
}

/** Recompute P(middle) shells after score/clock change (same package set). */
export function refreshSoccerMiddleArbCacheState(
  cache: SoccerMiddleArbEventCache,
  scoreHome: number,
  scoreAway: number,
  minsLeft: number,
): SoccerMiddleArbEventCache {
  const packages = cache.packages.map((pkg) => ({
    ...pkg,
    state: computePackageState({
      marketType: pkg.marketType,
      bandLo: pkg.bandLo,
      bandHi: pkg.bandHi,
      spreadSide: pkg.spreadSide,
      spreadTeamKey: pkg.spreadTeamKey,
      scoreHome,
      scoreAway,
      minsLeft,
      homeTeamKey: cache.homeTeamKey,
      awayTeamKey: cache.awayTeamKey,
    }),
  }));
  return {
    ...cache,
    packages,
    stateUpdatedAt: Date.now(),
  };
}

export function inferT1BranchFromMlShock(input: {
  cache: SoccerMiddleArbEventCache;
  /** Team keys whose ML YES ask dropped (became more favored). */
  cheapenedTeamKeys: string[];
  /** If set, prefer this market type's default branch. */
  preferTotals?: boolean;
}): SoccerT1Branch {
  if (input.preferTotals || input.cheapenedTeamKeys.length === 0) {
    return { kind: "total_plus_1" };
  }
  // Prefer non-draw team keys present on the event.
  for (const key of input.cheapenedTeamKeys) {
    if (key === cacheDrawKey()) continue;
    if (
      key === input.cache.homeTeamKey
      || key === input.cache.awayTeamKey
      || input.cache.packages.some((p) => p.spreadTeamKey === key)
    ) {
      return { kind: "team_plus_1", teamKey: key };
    }
  }
  return { kind: "total_plus_1" };
}

function cacheDrawKey(): string {
  return "draw";
}

/**
 * Effective cost ceiling for a package: min(scanHi, maxLiveCost).
 * Shock lane still applies scanLo via leg screen.
 */
export function effectiveMaxCost(pkg: SoccerMiddleArbCachedPackage): number {
  return Math.min(pkg.costBands.scanHi, pkg.costBands.maxLiveCost);
}

/**
 * Evaluate one cached package at live TOB under a T+1 branch + shock features.
 */
export function evaluateSoccerMiddleArbCachedPackage(input: {
  cache: SoccerMiddleArbEventCache;
  pkg: SoccerMiddleArbCachedPackage;
  tob: SoccerMiddleArbLiveTob;
  shock: { maxMlJumpAbs: number; maxTotalMoveAbs: number; afterFt?: boolean };
  branch: SoccerT1Branch;
  /** If true, also require cost <= shape maxLiveCost. Default true. */
  enforceShapeCostCap?: boolean;
}): SoccerMiddleArbEvalHit | null {
  const { pkg, tob, cache } = input;
  const cost = tob.broadYesAsk + tob.narrowNoAsk;
  const size = Math.min(tob.broadYesAskSize ?? Infinity, tob.narrowNoAskSize ?? Infinity);
  const pCurrent = pkg.state.pCurrent;
  const pTPlus1 = resolveBranchP(cache, pkg, input.branch);
  const edgeAtCurrent = 1 + pCurrent - cost;
  const edgeAtTPlus1 = 1 + pTPlus1 - cost;

  if (input.enforceShapeCostCap !== false && cost > effectiveMaxCost(pkg) + 1e-9) {
    return {
      pkg,
      branch: input.branch,
      cost,
      size: Number.isFinite(size) ? size : 0,
      pCurrent,
      pTPlus1,
      edgeAtCurrent,
      edgeAtTPlus1,
      screen: { ok: false, reason: "cost_out_of_band" },
    };
  }

  const screen = screenSoccerMiddleArb({
    legs: { broadYesAsk: tob.broadYesAsk, narrowNoAsk: tob.narrowNoAsk },
    shock: input.shock,
    ev: { edgeAtCurrent, edgeAtTPlus1 },
  });

  return {
    pkg,
    branch: input.branch,
    cost,
    size: Number.isFinite(size) ? size : 0,
    pCurrent,
    pTPlus1,
    edgeAtCurrent,
    edgeAtTPlus1,
    screen,
  };
}

/** Scan all cached packages; return those that pass the full screen. */
export function collectSoccerMiddleArbShockHits(input: {
  cache: SoccerMiddleArbEventCache;
  /** packageId → live TOB */
  tobByPackageId: Map<string, SoccerMiddleArbLiveTob> | Record<string, SoccerMiddleArbLiveTob>;
  shock: { maxMlJumpAbs: number; maxTotalMoveAbs: number; afterFt?: boolean };
  branch: SoccerT1Branch;
  enforceShapeCostCap?: boolean;
}): SoccerMiddleArbEvalHit[] {
  const map = input.tobByPackageId instanceof Map
    ? input.tobByPackageId
    : new Map(Object.entries(input.tobByPackageId));

  const hits: SoccerMiddleArbEvalHit[] = [];
  for (const pkg of input.cache.packages) {
    // Totals ignore team branch; spreads need team_plus_1 (or skip).
    let branch = input.branch;
    if (pkg.marketType === "match_total") {
      branch = { kind: "total_plus_1" };
    } else if (branch.kind === "total_plus_1") {
      continue; // need a scorer for spread packages
    }

    const tob = map.get(pkg.packageId);
    if (!tob) continue;
    const hit = evaluateSoccerMiddleArbCachedPackage({
      cache: input.cache,
      pkg,
      tob,
      shock: input.shock,
      branch,
      enforceShapeCostCap: input.enforceShapeCostCap,
    });
    if (hit?.screen.ok) hits.push(hit);
  }
  hits.sort((a, b) => b.edgeAtTPlus1 - a.edgeAtTPlus1);
  return hits;
}

/** JSON-safe snapshot for paper logs / debugging. */
export function serializeSoccerMiddleArbEventCache(
  cache: SoccerMiddleArbEventCache,
): Record<string, unknown> {
  return {
    version: cache.version,
    filtersVersion: cache.filtersVersion,
    eventSlug: cache.eventSlug,
    eventTitle: cache.eventTitle,
    awayTeamKey: cache.awayTeamKey,
    homeTeamKey: cache.homeTeamKey,
    mlTokens: cache.mlTokens,
    builtAt: cache.builtAt,
    stateUpdatedAt: cache.stateUpdatedAt,
    packages: cache.packages.map((p) => ({
      packageId: p.packageId,
      marketType: p.marketType,
      lineFamily: p.lineFamily,
      middleWidth: p.middleWidth,
      shapeKey: p.shapeKey,
      bandLo: p.bandLo,
      bandHi: p.bandHi,
      tokens: {
        broadYes: p.broadYesTokenId,
        narrowNo: p.narrowNoTokenId,
        narrowYes: p.narrowYesTokenId,
      },
      spreadTeamKey: p.spreadTeamKey,
      spreadSide: p.spreadSide,
      costBands: p.costBands,
      state: p.state,
    })),
  };
}

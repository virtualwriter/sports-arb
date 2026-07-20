/**
 * Per-event cache for MLB middle-arb paper lane.
 *
 * Allowlisted game_total / spread packages + P(middle) state refreshed from
 * StatsAPI (innings/outs/bases) whenever the score feed updates. Fair comes
 * from the empirical PA-chain MC (mlb-pa-chain.ts) with the Strat2 Poisson
 * as fallback when the kernel or game state is unavailable.
 */

import type { Candidate, MarketQuote } from "./monotonic-arb-core.js";
import {
  backtestLineFamily,
  backtestMiddleWidth,
  backtestShapeKey,
  loadSportsBacktestPositiveShapes,
  type SportsBacktestShape,
} from "./soccer-backtest-live-gate.js";
import {
  KalshiMlbSpreadsFeed,
  KalshiMlbTotalsFeed,
  type KalshiMlbSpreadRung,
} from "./kalshi-mlb-ws-feed.js";
import {
  EDGE_MARGIN,
  MAX_PACKAGE_COST,
  MLB_MIDDLE_ARB_FILTERS_VERSION,
} from "./mlb-middle-arb-filters.js";
import {
  isTerminalSpreadState,
  isTerminalState,
  resolveSpreadSide,
  spreadTeamKeyFromLadder,
  type Strat2State,
} from "./strat2-mlb-live-gate.js";
import {
  computeMlbBandState,
  computeMlbSpreadBandState,
} from "./mlb-pa-chain.js";
import type { FeedSnapshot } from "./state-feed-map.js";
import {
  buildActiveRbiBranches,
  type MlbScoreBranch,
} from "./mlb-rbi-branches.js";
import type { MarketType } from "./types.js";

export const MLB_MIDDLE_ARB_CACHE_VERSION = "2026-07-16.2";

export type MlbMiddleArbCostBands = {
  maxPackageCost: number;
  edgeMargin: number;
  maxLiveCost: number;
  worstAvgCost: number;
  middleRate: number;
};

export type MlbMiddleArbCachedPackage = {
  packageId: string;
  eventSlug: string;
  marketType: "game_total" | "spread";
  lineFamily: string;
  middleWidth: number;
  shapeKey: string;
  ladderKey: string;
  broadStrike: number;
  narrowStrike: number;
  bandLo: number;
  bandHi: number;
  broadYesTokenId: string;
  narrowNoTokenId: string;
  narrowYesTokenId: string;
  spreadTeamKey: string | null;
  spreadSide: "home" | "away" | null;
  costBands: MlbMiddleArbCostBands;
  /** Latest Strat2 state (null until feed available). */
  state: Strat2State | null;
  terminal: boolean;
  stateUpdatedAt: number;
};

/** Strat2 fair for one RBI counterfactual on one package. */
export type MlbRbiBranchEval = {
  rbiDelta: number;
  scoreAway: number;
  scoreHome: number;
  battingSide: "home" | "away";
  pMiddle: number;
  fair: number;
  terminal: boolean;
  /** fair − current cost when TOB known; else null. */
  edgeAtCost: number | null;
};

export type MlbMiddleArbEventCache = {
  version: string;
  filtersVersion: string;
  eventSlug: string;
  eventTitle: string;
  packages: MlbMiddleArbCachedPackage[];
  feed: FeedSnapshot | null;
  /** Active at-bat RBI branches from current runners / batting side. */
  rbiBranches: MlbScoreBranch[];
  /** packageId → evals for each active RBI delta (hunt menu). */
  branchEvalsByPackage: Record<string, MlbRbiBranchEval[]>;
  builtAt: number;
  stateUpdatedAt: number;
};

function classifyMlbMarketType(candidate: Candidate): "game_total" | "spread" | null {
  const key = candidate.broad.ladderKey.toLowerCase();
  if (key.includes(":spread:")) return "spread";
  if (key.includes(":total:")) return "game_total";
  return null;
}

/** When set, cache every structural total/spread middle (not only +ROI allowlist). */
export function mlbPaperAllShapesEnabled(): boolean {
  const v = (process.env.PLR_MLB_PAPER_ALL_SHAPES ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Max |hi−lo| for Kalshi-synthesized total middles (default: no cap). */
export function mlbPaperMaxMiddleWidth(): number | null {
  const raw = process.env.PLR_MLB_PAPER_MAX_WIDTH?.trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function emptyBook(tokenId: string): MarketQuote["yesBook"] {
  return { tokenId, bid: 0, bidSize: 0, ask: 0, askSize: 0, spread: 0.01, minOrderSize: 1 };
}

function kalshiTotalQuote(
  eventSlug: string,
  eventTitle: string,
  strike: number,
): MarketQuote {
  const tokenYes = `kalshi:total:${strike}:yes`;
  const tokenNo = `kalshi:total:${strike}:no`;
  return {
    eventSlug,
    eventTitle,
    marketId: `kalshi-total-${strike}`,
    ladderKey: `sports:mlb:${eventSlug}:total:full-game`,
    question: `O/U ${strike}`,
    description: "kalshi-synthetic",
    resolutionSource: "kalshi",
    strike,
    direction: "above",
    startDate: null,
    endDate: null,
    liquidity: 1,
    yesTokenId: tokenYes,
    noTokenId: tokenNo,
    yesBook: emptyBook(tokenYes),
    noBook: emptyBook(tokenNo),
  };
}

/**
 * Build game_total middle candidates for every Kalshi totals rung pair.
 * Paper prices these via kalshiTob (total_{strike}:yes/no); PM tokens are stubs.
 */
export function kalshiTotalMiddleCandidatesFromRungs(input: {
  eventSlug: string;
  eventTitle: string;
  foundAt: string;
  rungs: Iterable<number>;
  maxWidth?: number | null;
}): Candidate[] {
  const strikes = [...new Set(
    [...input.rungs].map(Number).filter((x) => Number.isFinite(x)),
  )].sort((a, b) => a - b);
  const maxWidth = input.maxWidth === undefined ? mlbPaperMaxMiddleWidth() : input.maxWidth;
  const out: Candidate[] = [];
  for (let i = 0; i < strikes.length; i++) {
    for (let j = i + 1; j < strikes.length; j++) {
      const lo = strikes[i]!;
      const hi = strikes[j]!;
      if (maxWidth != null && hi - lo > maxWidth + 1e-9) continue;
      const broad = kalshiTotalQuote(input.eventSlug, input.eventTitle, lo);
      const narrow = kalshiTotalQuote(input.eventSlug, input.eventTitle, hi);
      out.push({
        foundAt: input.foundAt,
        asset: "MLB",
        eventSlug: input.eventSlug,
        eventTitle: input.eventTitle,
        packageId: `${input.eventSlug}::kalshi::YES-${lo}+NO-${hi}`,
        direction: "above",
        broad,
        narrow,
        packageCost: 0,
        lockedEdge: 1,
        availableSize: 0,
        maxSpread: 0,
        minLiquidity: 0,
        jackpotPayoutPerShare: 2,
        eligible: true,
        rejectionReasons: [],
      });
    }
  }
  return out;
}

/** Discover open Kalshi totals rungs for this PM slug / event ticker. */
export async function findKalshiTotalMiddleCandidates(input: {
  eventSlug: string;
  eventTitle: string;
  foundAt: string;
  eventTicker?: string;
  maxWidth?: number | null;
}): Promise<{ candidates: Candidate[]; eventTicker: string | null; rungCount: number; error?: string }> {
  try {
    const discovered = await KalshiMlbTotalsFeed.discover(
      input.eventTicker
        ? { eventTicker: input.eventTicker }
        : { pmSlug: input.eventSlug },
    );
    const candidates = kalshiTotalMiddleCandidatesFromRungs({
      eventSlug: input.eventSlug,
      eventTitle: input.eventTitle,
      foundAt: input.foundAt,
      rungs: discovered.rungs.keys(),
      maxWidth: input.maxWidth,
    });
    return {
      candidates,
      eventTicker: discovered.eventTicker,
      rungCount: discovered.rungs.size,
    };
  } catch (e) {
    return {
      candidates: [],
      eventTicker: null,
      rungCount: 0,
      error: String(e).slice(0, 160),
    };
  }
}

function kalshiSpreadQuote(
  eventSlug: string,
  eventTitle: string,
  teamKey: string,
  strike: number,
): MarketQuote {
  // Positive strike in Candidate; TOB keys use negative lines (PM convention).
  const tokenYes = `kalshi:spread:${teamKey}:${strike}:yes`;
  const tokenNo = `kalshi:spread:${teamKey}:${strike}:no`;
  return {
    eventSlug,
    eventTitle,
    marketId: `kalshi-spread-${teamKey}-${strike}`,
    ladderKey: `sports:mlb:${eventSlug}:spread:full-game:${teamKey}`,
    question: `${teamKey} wins by over ${strike}`,
    description: "kalshi-synthetic",
    resolutionSource: "kalshi",
    strike,
    direction: "above",
    startDate: null,
    endDate: null,
    liquidity: 1,
    yesTokenId: tokenYes,
    noTokenId: tokenNo,
    yesBook: emptyBook(tokenYes),
    noBook: emptyBook(tokenNo),
  };
}

/** Per-team Kalshi spread rung pairs → paper Candidates. */
export function kalshiSpreadMiddleCandidatesFromRungs(input: {
  eventSlug: string;
  eventTitle: string;
  foundAt: string;
  rungs: KalshiMlbSpreadRung[];
  maxWidth?: number | null;
}): Candidate[] {
  const maxWidth = input.maxWidth === undefined ? mlbPaperMaxMiddleWidth() : input.maxWidth;
  const byTeam = new Map<string, number[]>();
  for (const r of input.rungs) {
    const list = byTeam.get(r.teamKey) ?? [];
    list.push(r.strike);
    byTeam.set(r.teamKey, list);
  }
  const out: Candidate[] = [];
  for (const [teamKey, raw] of byTeam) {
    const strikes = [...new Set(raw)].sort((a, b) => a - b);
    for (let i = 0; i < strikes.length; i++) {
      for (let j = i + 1; j < strikes.length; j++) {
        const lo = strikes[i]!;
        const hi = strikes[j]!;
        if (maxWidth != null && hi - lo > maxWidth + 1e-9) continue;
        const broad = kalshiSpreadQuote(input.eventSlug, input.eventTitle, teamKey, lo);
        const narrow = kalshiSpreadQuote(input.eventSlug, input.eventTitle, teamKey, hi);
        out.push({
          foundAt: input.foundAt,
          asset: "MLB",
          eventSlug: input.eventSlug,
          eventTitle: input.eventTitle,
          packageId: `${input.eventSlug}::kalshi::spread::${teamKey}::YES-${lo}+NO-${hi}`,
          direction: "above",
          broad,
          narrow,
          packageCost: 0,
          lockedEdge: 1,
          availableSize: 0,
          maxSpread: 0,
          minLiquidity: 0,
          jackpotPayoutPerShare: 2,
          eligible: true,
          rejectionReasons: [],
        });
      }
    }
  }
  return out;
}

/** Discover Kalshi full-game spread ladders and build middle candidates. */
export async function findKalshiSpreadMiddleCandidates(input: {
  eventSlug: string;
  eventTitle: string;
  foundAt: string;
  totalsEventTicker?: string;
  spreadEventTicker?: string;
  maxWidth?: number | null;
}): Promise<{
  candidates: Candidate[];
  eventTicker: string | null;
  rungCount: number;
  teamCount: number;
  error?: string;
}> {
  try {
    const discovered = await KalshiMlbSpreadsFeed.discover({
      eventTicker: input.spreadEventTicker,
      totalsEventTicker: input.totalsEventTicker,
      pmSlug: input.eventSlug,
      eventTitle: input.eventTitle,
    });
    const candidates = kalshiSpreadMiddleCandidatesFromRungs({
      eventSlug: input.eventSlug,
      eventTitle: input.eventTitle,
      foundAt: input.foundAt,
      rungs: discovered.rungs,
      maxWidth: input.maxWidth,
    });
    const teams = new Set(discovered.rungs.map((r) => r.teamKey));
    return {
      candidates,
      eventTicker: discovered.eventTicker,
      rungCount: discovered.rungs.length,
      teamCount: teams.size,
    };
  } catch (e) {
    return {
      candidates: [],
      eventTicker: null,
      rungCount: 0,
      teamCount: 0,
      error: String(e).slice(0, 160),
    };
  }
}

/**
 * Prefer Polymarket structural packages when both venues share the same
 * ladder+band; keep Kalshi-only full-game totals so every offered rung pair
 * is evaluated. Key must include ladderKey — PM F5/team-total 3.5–4.5 must
 * not clobber Kalshi full-game 3.5–4.5.
 */
export function mergeMlbPaperCandidates(pm: Candidate[], kalshi: Candidate[]): Candidate[] {
  const bandKey = (c: Candidate) => {
    const lo = Math.min(c.broad.strike, c.narrow.strike);
    const hi = Math.max(c.broad.strike, c.narrow.strike);
    return `${c.direction}|${c.broad.ladderKey}|${lo}|${hi}`;
  };
  const byBand = new Map<string, Candidate>();
  for (const c of kalshi) byBand.set(bandKey(c), c);
  for (const c of pm) byBand.set(bandKey(c), c); // PM wins same-ladder ties (real CLOB tokens)
  return [...byBand.values()];
}

function syntheticShape(
  marketType: "game_total" | "spread",
  lineFamily: string,
  middleWidth: number,
): SportsBacktestShape {
  return {
    asset: "MLB",
    marketType,
    lineFamily,
    middleWidth,
    resolved: 0,
    middleRate: 0,
    worstRoiPct: 0,
    worstAvgCost: MAX_PACKAGE_COST,
    maxLiveCost: MAX_PACKAGE_COST,
  };
}

export function buildMlbMiddleArbEventCache(input: {
  eventSlug: string;
  eventTitle: string;
  candidates: Candidate[];
  shapes?: Map<string, SportsBacktestShape>;
  feed?: FeedSnapshot | null;
  /** Include candidates missing from the +ROI allowlist (paper research). */
  allShapes?: boolean;
}): MlbMiddleArbEventCache {
  const shapes = input.shapes ?? loadSportsBacktestPositiveShapes();
  const allShapes = input.allShapes ?? mlbPaperAllShapesEnabled();
  const packages: MlbMiddleArbCachedPackage[] = [];

  for (const candidate of input.candidates) {
    if (candidate.eventSlug !== input.eventSlug) continue;
    const asset = String(candidate.asset ?? "").toUpperCase();
    if (asset && asset !== "MLB") continue;
    const marketType = classifyMlbMarketType(candidate);
    if (!marketType) continue;

    const lineFamily = backtestLineFamily(candidate, marketType as MarketType);
    const middleWidth = backtestMiddleWidth(candidate);
    const shapeKey = backtestShapeKey("MLB", marketType, lineFamily, middleWidth);
    const shape = shapes.get(shapeKey) ?? (allShapes ? syntheticShape(marketType, lineFamily, middleWidth) : null);
    if (!shape) continue;

    const bandLo = Math.min(candidate.broad.strike, candidate.narrow.strike);
    const bandHi = Math.max(candidate.broad.strike, candidate.narrow.strike);
    const spreadTeamKey =
      marketType === "spread" ? spreadTeamKeyFromLadder(candidate.broad.ladderKey) : null;
    const spreadSide =
      marketType === "spread"
        ? resolveSpreadSide(input.eventTitle, candidate.broad.ladderKey)
        : null;

    packages.push({
      packageId: candidate.packageId,
      eventSlug: input.eventSlug,
      marketType,
      lineFamily,
      middleWidth,
      shapeKey,
      ladderKey: candidate.broad.ladderKey,
      broadStrike: candidate.broad.strike,
      narrowStrike: candidate.narrow.strike,
      bandLo,
      bandHi,
      broadYesTokenId: candidate.broad.yesTokenId,
      narrowNoTokenId: candidate.narrow.noTokenId,
      narrowYesTokenId: candidate.narrow.yesTokenId,
      spreadTeamKey,
      spreadSide,
      costBands: {
        maxPackageCost: MAX_PACKAGE_COST,
        edgeMargin: EDGE_MARGIN,
        maxLiveCost: shape.maxLiveCost,
        worstAvgCost: shape.worstAvgCost,
        middleRate: shape.middleRate,
      },
      state: null,
      terminal: false,
      stateUpdatedAt: 0,
    });
  }

  packages.sort((a, b) => a.shapeKey.localeCompare(b.shapeKey) || a.packageId.localeCompare(b.packageId));
  const now = Date.now();
  const cache: MlbMiddleArbEventCache = {
    version: MLB_MIDDLE_ARB_CACHE_VERSION,
    filtersVersion: MLB_MIDDLE_ARB_FILTERS_VERSION,
    eventSlug: input.eventSlug,
    eventTitle: input.eventTitle,
    packages,
    feed: input.feed ?? null,
    rbiBranches: [],
    branchEvalsByPackage: {},
    builtAt: now,
    stateUpdatedAt: now,
  };
  if (input.feed) return refreshMlbMiddleArbCacheState(cache, input.feed);
  return cache;
}

function evalPackageAtScore(
  pkg: MlbMiddleArbCachedPackage,
  feed: FeedSnapshot,
  scoreAway: number,
  scoreHome: number,
): { state: Strat2State | null; terminal: boolean } {
  const branched: FeedSnapshot = { ...feed, scoreAway, scoreHome, live: true };
  if (pkg.marketType === "game_total") {
    const state = computeMlbBandState(branched, pkg.bandLo, pkg.bandHi);
    const terminal = state
      ? isTerminalState(state.inningsLeft, state.currentTotal, pkg.bandLo, pkg.bandHi)
      : false;
    return { state, terminal };
  }
  if (pkg.spreadSide) {
    const state = computeMlbSpreadBandState(branched, pkg.bandLo, pkg.bandHi, pkg.spreadSide);
    const terminal = state && state.currentMargin != null
      ? isTerminalSpreadState(state.inningsLeft, state.currentMargin, pkg.bandLo, pkg.bandHi)
      : false;
    return { state, terminal };
  }
  return { state: null, terminal: false };
}

export function refreshMlbMiddleArbCacheState(
  cache: MlbMiddleArbEventCache,
  feed: FeedSnapshot,
): MlbMiddleArbEventCache {
  const now = Date.now();
  const packages = cache.packages.map((pkg) => {
    const { state, terminal } = evalPackageAtScore(
      pkg,
      feed,
      feed.scoreAway ?? 0,
      feed.scoreHome ?? 0,
    );
    return { ...pkg, state, terminal, stateUpdatedAt: now };
  });

  const scoreAway = feed.scoreAway ?? 0;
  const scoreHome = feed.scoreHome ?? 0;
  const rbiBranches = buildActiveRbiBranches({
    scoreAway,
    scoreHome,
    battingSide: feed.battingSide,
    runnersOn: feed.runnersOn,
  });

  const branchEvalsByPackage: Record<string, MlbRbiBranchEval[]> = {};
  for (const pkg of packages) {
    branchEvalsByPackage[pkg.packageId] = rbiBranches.map((branch) => {
      const { state, terminal } = evalPackageAtScore(
        pkg,
        feed,
        branch.scoreAway,
        branch.scoreHome,
      );
      return {
        rbiDelta: branch.rbiDelta,
        scoreAway: branch.scoreAway,
        scoreHome: branch.scoreHome,
        battingSide: branch.battingSide,
        pMiddle: state?.pMiddle ?? 0,
        fair: state?.fair ?? 1,
        terminal,
        edgeAtCost: null,
      };
    });
  }

  return {
    ...cache,
    packages,
    feed,
    rbiBranches,
    branchEvalsByPackage,
    stateUpdatedAt: now,
  };
}

/** Rank packages to hunt for a confirmed RBI delta (highest fair / edge first). */
export function huntListForRbiDelta(
  cache: MlbMiddleArbEventCache,
  rbiDelta: number,
  costByPackageId?: Map<string, number> | Record<string, number>,
): Array<{
  packageId: string;
  lineFamily: string;
  marketType: string;
  rbiDelta: number;
  fair: number;
  pMiddle: number;
  terminal: boolean;
  edge: number | null;
  cost: number | null;
}> {
  const costMap = costByPackageId instanceof Map
    ? costByPackageId
    : new Map(Object.entries(costByPackageId ?? {}));
  const out = [];
  for (const pkg of cache.packages) {
    const evals = cache.branchEvalsByPackage[pkg.packageId] ?? [];
    const hit = evals.find((e) => e.rbiDelta === rbiDelta);
    if (!hit || hit.terminal) continue;
    const cost = costMap.get(pkg.packageId);
    const edge = cost != null ? hit.fair - cost : null;
    out.push({
      packageId: pkg.packageId,
      lineFamily: pkg.lineFamily,
      marketType: pkg.marketType,
      rbiDelta,
      fair: hit.fair,
      pMiddle: hit.pMiddle,
      terminal: hit.terminal,
      edge,
      cost: cost ?? null,
    });
  }
  out.sort((a, b) => (b.edge ?? b.fair) - (a.edge ?? a.fair));
  return out;
}

export function serializeMlbMiddleArbEventCache(cache: MlbMiddleArbEventCache): Record<string, unknown> {
  return {
    version: cache.version,
    filtersVersion: cache.filtersVersion,
    eventSlug: cache.eventSlug,
    eventTitle: cache.eventTitle,
    builtAt: cache.builtAt,
    stateUpdatedAt: cache.stateUpdatedAt,
    feed: cache.feed,
    rbiBranches: cache.rbiBranches,
    packages: cache.packages.map((p) => ({
      packageId: p.packageId,
      marketType: p.marketType,
      lineFamily: p.lineFamily,
      shapeKey: p.shapeKey,
      bandLo: p.bandLo,
      bandHi: p.bandHi,
      spreadTeamKey: p.spreadTeamKey,
      spreadSide: p.spreadSide,
      costBands: p.costBands,
      terminal: p.terminal,
      state: p.state,
      rbiBranches: cache.branchEvalsByPackage[p.packageId] ?? [],
    })),
  };
}

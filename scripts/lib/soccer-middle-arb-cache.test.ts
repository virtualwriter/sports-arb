import { describe, expect, it } from "vitest";
import type { Candidate, MarketQuote } from "./monotonic-arb-core.js";
import type { SportsBacktestShape } from "./soccer-backtest-live-gate.js";
import {
  buildSoccerMiddleArbEventCache,
  collectSoccerMiddleArbShockHits,
  evaluateSoccerMiddleArbCachedPackage,
  parseBacktestLineFamily,
  refreshSoccerMiddleArbCacheState,
  serializeSoccerMiddleArbEventCache,
} from "./soccer-middle-arb-cache.js";

function quote(overrides: Partial<MarketQuote>): MarketQuote {
  return {
    eventSlug: "fifwc-eng-arg-2026-07-15",
    eventTitle: "England vs. Argentina",
    marketId: "m1",
    ladderKey: "sports:soccer:fifwc-eng-arg-2026-07-15:total:full-game",
    question: "England vs. Argentina: O/U 2.5",
    description: "",
    resolutionSource: "",
    strike: 2.5,
    direction: "above",
    startDate: null,
    endDate: null,
    liquidity: 100,
    yesTokenId: "yes1",
    noTokenId: "no1",
    yesBook: { tokenId: "yes1", bid: 0, bidSize: 0, ask: 0, askSize: 0, spread: 0.01, minOrderSize: 1 },
    noBook: { tokenId: "no1", bid: 0, bidSize: 0, ask: 0, askSize: 0, spread: 0.01, minOrderSize: 1 },
    ...overrides,
  };
}

function totalCandidate(lo: number, hi: number): Candidate {
  const broad = quote({
    marketId: `t${lo}`,
    strike: lo,
    question: `England vs. Argentina: O/U ${lo}`,
    yesTokenId: `yes-t${lo}`,
    noTokenId: `no-t${lo}`,
  });
  const narrow = quote({
    marketId: `t${hi}`,
    strike: hi,
    question: `England vs. Argentina: O/U ${hi}`,
    yesTokenId: `yes-t${hi}`,
    noTokenId: `no-t${hi}`,
    yesBook: { tokenId: `yes-t${hi}`, bid: 0, bidSize: 0, ask: 0, askSize: 0, spread: 0.01, minOrderSize: 1 },
    noBook: { tokenId: `no-t${hi}`, bid: 0, bidSize: 0, ask: 0, askSize: 0, spread: 0.01, minOrderSize: 1 },
  });
  return {
    foundAt: new Date().toISOString(),
    asset: "SOCCER",
    eventSlug: "fifwc-eng-arg-2026-07-15",
    eventTitle: "England vs. Argentina",
    packageId: `fifwc-eng-arg-2026-07-15::YES-${broad.marketId}+NO-${narrow.marketId}`,
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
  };
}

function spreadCandidate(team: string, loMag: number, hiMag: number): Candidate {
  const ladderKey = `sports:soccer:fifwc-eng-arg-2026-07-15:spread:full-game:${team}`;
  const broad = quote({
    marketId: `s${team}${loMag}`,
    ladderKey,
    strike: loMag,
    question: `Spread: ${team} (-${loMag})`,
    yesTokenId: `yes-s${team}${loMag}`,
    noTokenId: `no-s${team}${loMag}`,
  });
  const narrow = quote({
    marketId: `s${team}${hiMag}`,
    ladderKey,
    strike: hiMag,
    question: `Spread: ${team} (-${hiMag})`,
    yesTokenId: `yes-s${team}${hiMag}`,
    noTokenId: `no-s${team}${hiMag}`,
    yesBook: { tokenId: `yes-s${team}${hiMag}`, bid: 0, bidSize: 0, ask: 0, askSize: 0, spread: 0.01, minOrderSize: 1 },
    noBook: { tokenId: `no-s${team}${hiMag}`, bid: 0, bidSize: 0, ask: 0, askSize: 0, spread: 0.01, minOrderSize: 1 },
  });
  return {
    ...totalCandidate(loMag, hiMag),
    packageId: `fifwc-eng-arg-2026-07-15::YES-${broad.marketId}+NO-${narrow.marketId}`,
    broad,
    narrow,
  };
}

function shape(
  marketType: string,
  lineFamily: string,
  middleWidth: number,
  maxLiveCost = 1.35,
): [string, SportsBacktestShape] {
  const key = `SOCCER|${marketType}|${lineFamily}|w${middleWidth}`;
  return [
    key,
    {
      asset: "SOCCER",
      marketType,
      lineFamily,
      middleWidth,
      resolved: 20,
      middleRate: 0.35,
      worstRoiPct: 2,
      worstAvgCost: maxLiveCost,
      maxLiveCost,
    },
  ];
}

describe("soccer middle arb cache", () => {
  it("parses signed spread families", () => {
    expect(parseBacktestLineFamily("2.5-3.5", "match_total")).toEqual({ lo: 2.5, hi: 3.5 });
    expect(parseBacktestLineFamily("-3.5--1.5", "spread")).toEqual({ lo: -3.5, hi: -1.5 });
  });

  it("caches totals T+1 and spread team branches with cost bands", () => {
    const shapes = new Map([
      shape("match_total", "2.5-3.5", 1),
      shape("match_total", "1.5-3.5", 2),
      shape("spread", "-3.5--1.5", 2),
      shape("match_total", "9.5-10.5", 1), // not in candidates
    ]);

    const cache = buildSoccerMiddleArbEventCache({
      eventSlug: "fifwc-eng-arg-2026-07-15",
      eventTitle: "England vs. Argentina",
      candidates: [
        totalCandidate(2.5, 3.5),
        totalCandidate(1.5, 3.5),
        spreadCandidate("england", 1.5, 3.5),
        totalCandidate(4.5, 5.5), // not allowlisted
      ],
      scoreHome: 0,
      scoreAway: 0,
      minsLeft: 36,
      shapes,
      mlTokens: {
        awayYesTokenId: "ml-eng",
        homeYesTokenId: "ml-arg",
        byTeamKey: { england: "ml-eng", argentina: "ml-arg" },
      },
    });

    expect(cache.awayTeamKey).toBe("england");
    expect(cache.homeTeamKey).toBe("argentina");
    expect(cache.packages).toHaveLength(3);

    const tot = cache.packages.find((p) => p.lineFamily === "2.5-3.5")!;
    expect(tot.marketType).toBe("match_total");
    expect(tot.broadYesTokenId).toBe("yes-t2.5");
    expect(tot.narrowNoTokenId).toBe("no-t3.5");
    expect(tot.costBands.scanLo).toBe(0.85);
    expect(tot.costBands.scanHi).toBe(1.45);
    expect(tot.costBands.maxLiveCost).toBe(1.35);
    expect(tot.state.pTotalPlus1).toBeGreaterThan(tot.state.pCurrent);

    const spr = cache.packages.find((p) => p.marketType === "spread")!;
    expect(spr.spreadTeamKey).toBe("england");
    expect(spr.spreadSide).toBe("away");
    expect(spr.state.pByScorer.england).toBeDefined();
    expect(spr.state.pByScorer.argentina).toBeDefined();
    expect(spr.state.pHomePlus1).not.toBe(spr.state.pAwayPlus1);

    const refreshed = refreshSoccerMiddleArbCacheState(cache, 1, 1, 3);
    const late = refreshed.packages.find((p) => p.lineFamily === "2.5-3.5")!;
    expect(late.state.scoreHome).toBe(1);
    expect(late.state.scoreAway).toBe(1);
    expect(late.state.pTotalPlus1).toBeGreaterThan(0.8);

    const snap = serializeSoccerMiddleArbEventCache(refreshed);
    expect(snap.packages).toHaveLength(3);
  });

  it("evaluates shock hits for the ENG–ARG style keeper", () => {
    const shapes = new Map([shape("match_total", "2.5-3.5", 1, 1.4)]);
    const cache = buildSoccerMiddleArbEventCache({
      eventSlug: "fifwc-eng-arg-2026-07-15",
      eventTitle: "England vs. Argentina",
      candidates: [totalCandidate(2.5, 3.5)],
      scoreHome: 1,
      scoreAway: 1,
      minsLeft: 3,
      shapes,
    });
    const pkg = cache.packages[0]!;

    const hit = evaluateSoccerMiddleArbCachedPackage({
      cache,
      pkg,
      tob: { broadYesAsk: 0.2725, narrowNoAsk: 0.975, broadYesAskSize: 50, narrowNoAskSize: 50 },
      shock: { maxMlJumpAbs: 0.26, maxTotalMoveAbs: 0.04 },
      branch: { kind: "total_plus_1" },
      enforceShapeCostCap: false,
    });
    expect(hit?.screen.ok).toBe(true);
    expect(hit!.edgeAtTPlus1).toBeGreaterThan(0.5);

    const hits = collectSoccerMiddleArbShockHits({
      cache,
      tobByPackageId: {
        [pkg.packageId]: { broadYesAsk: 0.2725, narrowNoAsk: 0.975, broadYesAskSize: 50, narrowNoAskSize: 50 },
      },
      shock: { maxMlJumpAbs: 0.26, maxTotalMoveAbs: 0.04 },
      branch: { kind: "total_plus_1" },
      enforceShapeCostCap: false,
    });
    expect(hits).toHaveLength(1);
  });
});

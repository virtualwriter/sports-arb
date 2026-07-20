import { describe, expect, it } from "vitest";
import type { Candidate, MarketQuote } from "./monotonic-arb-core.js";
import type { SportsBacktestShape } from "./soccer-backtest-live-gate.js";
import { buildMlbMiddleArbEventCache } from "./mlb-middle-arb-cache.js";
import { MlbMiddleArbPaperSidecar } from "./mlb-middle-arb-paper.js";
import type { FeedSnapshot } from "./state-feed-map.js";

function quote(overrides: Partial<MarketQuote>): MarketQuote {
  return {
    eventSlug: "mlb-sea-tb-2026-07-16",
    eventTitle: "Mariners vs. Rays",
    marketId: "m1",
    ladderKey: "sports:mlb:mlb-sea-tb-2026-07-16:total:full-game",
    question: "Mariners vs. Rays: O/U 7.5",
    description: "",
    resolutionSource: "",
    strike: 7.5,
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
    question: `Mariners vs. Rays: O/U ${lo}`,
    yesTokenId: `yes-t${lo}`,
    noTokenId: `no-t${lo}`,
  });
  const narrow = quote({
    marketId: `t${hi}`,
    strike: hi,
    question: `Mariners vs. Rays: O/U ${hi}`,
    yesTokenId: `yes-t${hi}`,
    noTokenId: `no-t${hi}`,
    yesBook: { tokenId: `yes-t${hi}`, bid: 0, bidSize: 0, ask: 0, askSize: 0, spread: 0.01, minOrderSize: 1 },
    noBook: { tokenId: `no-t${hi}`, bid: 0, bidSize: 0, ask: 0, askSize: 0, spread: 0.01, minOrderSize: 1 },
  });
  return {
    foundAt: new Date().toISOString(),
    asset: "MLB",
    eventSlug: "mlb-sea-tb-2026-07-16",
    eventTitle: "Mariners vs. Rays",
    packageId: `pkg-${lo}-${hi}`,
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

describe("mlb middle arb paper", () => {
  it("ranks edge gain on score and tracks book reprice window", async () => {
    const shapes = new Map<string, SportsBacktestShape>([
      [
        "MLB|game_total|7.5-8.5|w1",
        {
          asset: "MLB",
          marketType: "game_total",
          lineFamily: "7.5-8.5",
          middleWidth: 1,
          resolved: 20,
          middleRate: 0.25,
          worstRoiPct: 2,
          worstAvgCost: 1.4,
          maxLiveCost: 1.4,
        },
      ],
    ]);

    const feed0: FeedSnapshot = {
      source: "statsapi",
      feedId: "1",
      live: true,
      scoreHome: 4,
      scoreAway: 3,
      period: "Bottom 8",
      outs: 2,
      clock: null,
      status: "Live",
      rawScoreKey: "3-4",
      runnersOn: 2,
      onFirst: true,
      onSecond: true,
      onThird: false,
      battingSide: "home",
    };

    const cache = buildMlbMiddleArbEventCache({
      eventSlug: "mlb-sea-tb-2026-07-16",
      eventTitle: "Mariners vs. Rays",
      candidates: [totalCandidate(7.5, 8.5)],
      shapes,
      feed: feed0,
    });
    expect(cache.packages).toHaveLength(1);
    expect(cache.packages[0]!.state?.pMiddle).toBeGreaterThan(0);

    const rows: Record<string, unknown>[] = [];
    const paper = new MlbMiddleArbPaperSidecar({
      eventSlug: "mlb-sea-tb-2026-07-16",
      eventTitle: "Mariners vs. Rays",
      emit: (r) => rows.push(r),
    });
    paper.hydrateForTests(cache, { away: 3, home: 4 });
    expect(paper.stats.paPriorsLoaded).toBe(true);

    // Force an RBI menu emit with runners/outs for PA weighting.
    (paper as any).emitRbiMenu("test", true);
    const menu = rows.find((r) => r.kind === "mlb_paper_rbi_menu") as any;
    expect(menu).toBeTruthy();
    expect(menu.bases).toBe("12-");
    expect(menu.paPrior?.source).toBe("outs_bases");
    expect(menu.branches?.length).toBeGreaterThanOrEqual(1);
    expect(menu.branches[0]).toMatchObject({
      pWeight: expect.any(Number),
      pRbi: expect.any(Number),
    });
    const weightSum = menu.branches.reduce((s: number, b: any) => s + b.pWeight, 0);
    expect(weightSum).toBeCloseTo(1, 5);
    expect(menu.topExpectedEdgePa?.length).toBeGreaterThanOrEqual(1);
    expect(menu.confirmPath).toBe("strat2_on_realized_rbi");

    const t0 = Date.now();
    paper.onLadder({ market: "total_7.5", klass: "total", side: "yes", bestAsk: 0.42, bestAskSize: 80, t: t0 });
    paper.onLadder({ market: "total_8.5", klass: "total", side: "no", bestAsk: 0.72, bestAskSize: 80, t: t0 });
    paper.onLadder({ market: "moneyline", klass: "moneyline", side: "yes", bestAsk: 0.5, bestAskSize: 100, t: t0 });

    // Late game: total 7→8 lands in (7.5, 8.5] with little baseball left → P jumps
    paper.onPmScore("4-4", "Bottom 8", t0 + 10);
    await new Promise((r) => setTimeout(r, 150));

    // Book starts moving
    paper.onLadder({ market: "moneyline", klass: "moneyline", side: "yes", bestAsk: 0.55, bestAskSize: 100, t: t0 + 80 });
    paper.onLadder({ market: "total_7.5", klass: "total", side: "yes", bestAsk: 0.48, bestAskSize: 40, t: t0 + 120 });
    paper.onLadder({ market: "total_8.5", klass: "total", side: "no", bestAsk: 0.75, bestAskSize: 40, t: t0 + 200 });

    await new Promise((r) => setTimeout(r, 50));
    paper.end();

    const scoreEvent = rows.find((r) => r.kind === "mlb_paper_score_event") as any;
    expect(scoreEvent).toBeTruthy();
    expect(scoreEvent.scoreAway).toBe(4);
    expect(scoreEvent.scoreHome).toBe(4);
    expect(scoreEvent.rbiDelta).toBe(1);
    expect(scoreEvent.paCalibration).toMatchObject({
      bases: "12-",
      realizedRbiDelta: 1,
      pWeightRealized: expect.any(Number),
      priorSource: "outs_bases",
    });
    expect(scoreEvent.confirmPath).toBe("strat2_on_realized_rbi");
    expect(scoreEvent.topEdgeGains?.length).toBeGreaterThanOrEqual(1);
    expect(scoreEvent.topEdgeGains[0]).toMatchObject({
      lineFamily: "7.5-8.5",
      preEdge: expect.any(Number),
      postEdge: expect.any(Number),
      edgeGain: expect.any(Number),
    });

    const window = rows.find((r) => r.kind === "mlb_paper_score_window") as any;
    expect(window).toBeTruthy();
    expect(window.bookSignals.moneylineFirstMoveMs).toBeTypeOf("number");
    expect(window.bookSignals.totalFirstMoveMs).toBeTypeOf("number");
    expect(window.watched[0].path.length).toBeGreaterThanOrEqual(1);
    expect(window.watched[0].timeCostPlus3cMs).toBeTypeOf("number");
  });

  it("treats an emptied ask side as a missing quote, not zero cost", () => {
    const paper = new MlbMiddleArbPaperSidecar({
      eventSlug: "mlb-sea-tb-2026-07-16",
      eventTitle: "Mariners vs. Rays",
      emit: () => {},
    });
    const tob = (paper as any).tob as Map<string, unknown>;

    const t = Date.now();
    paper.onLadder({ market: "total_4.5", klass: "total", side: "yes", bestAsk: 0.99, bestAskSize: 2000, t });
    expect(tob.has("total_4.5:yes")).toBe(true);

    // Locked winner: every resting ask gets pulled → book empties.
    paper.onLadder({ market: "total_4.5", klass: "total", side: "yes", bestAsk: 0, bestAskSize: 0, t: t + 10 });
    expect(tob.has("total_4.5:yes")).toBe(false);

    // Positive ask with zero size is also unbuyable → missing.
    paper.onLadder({ market: "total_4.5", klass: "total", side: "yes", bestAsk: 0.99, bestAskSize: 0, t: t + 20 });
    expect(tob.has("total_4.5:yes")).toBe(false);

    // A real quote restores the entry.
    paper.onLadder({ market: "total_4.5", klass: "total", side: "yes", bestAsk: 0.99, bestAskSize: 50, t: t + 30 });
    expect(tob.has("total_4.5:yes")).toBe(true);
  });
});

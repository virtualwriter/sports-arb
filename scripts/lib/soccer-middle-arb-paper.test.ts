import { describe, expect, it } from "vitest";
import type { Candidate, MarketQuote } from "./monotonic-arb-core.js";
import type { SportsBacktestShape } from "./soccer-backtest-live-gate.js";
import { buildSoccerMiddleArbEventCache } from "./soccer-middle-arb-cache.js";
import { SoccerMiddleArbPaperSidecar } from "./soccer-middle-arb-paper.js";

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
    yesTokenId: `yes-t${lo}`,
    noTokenId: `no-t${lo}`,
  });
  const narrow = quote({
    marketId: `t${hi}`,
    strike: hi,
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

describe("soccer middle arb paper sidecar", () => {
  it("logs would_fire on goal-like shock with T+1 flip", async () => {
    const shapes = new Map<string, SportsBacktestShape>([
      [
        "SOCCER|match_total|2.5-3.5|w1",
        {
          asset: "SOCCER",
          marketType: "match_total",
          lineFamily: "2.5-3.5",
          middleWidth: 1,
          resolved: 20,
          middleRate: 0.3,
          worstRoiPct: 2,
          worstAvgCost: 1.4,
          maxLiveCost: 1.4,
        },
      ],
    ]);
    const cache = buildSoccerMiddleArbEventCache({
      eventSlug: "fifwc-eng-arg-2026-07-15",
      eventTitle: "England vs. Argentina",
      candidates: [totalCandidate(2.5, 3.5)],
      scoreHome: 1,
      scoreAway: 1,
      minsLeft: 3,
      shapes,
    });

    const rows: Record<string, unknown>[] = [];
    const paper = new SoccerMiddleArbPaperSidecar({
      eventSlug: "fifwc-eng-arg-2026-07-15",
      moreSlug: "fifwc-eng-arg-2026-07-15-more-markets",
      eventTitle: "England vs. Argentina",
      emit: (r) => rows.push(r),
    });
    paper.hydrateForTests(cache, { away: 1, home: 1, minsLeft: 3 });

    const t0 = Date.now();
    paper.onLadder({ market: "total_2.5", klass: "total", side: "yes", bestAsk: 0.2725, bestAskSize: 50, t: t0 });
    paper.onLadder({ market: "total_3.5", klass: "total", side: "no", bestAsk: 0.975, bestAskSize: 50, t: t0 });
    paper.onLadder({ market: "ml_argentina", klass: "moneyline", side: "yes", bestAsk: 0.55, bestAskSize: 100, t: t0 });
    // Concurrent total move + ML shock
    paper.onLadder({ market: "total_2.5", klass: "total", side: "yes", bestAsk: 0.32, bestAskSize: 40, t: t0 + 10 });
    paper.onLadder({ market: "total_2.5", klass: "total", side: "yes", bestAsk: 0.2725, bestAskSize: 50, t: t0 + 20 });
    paper.onLadder({ market: "ml_argentina", klass: "moneyline", side: "yes", bestAsk: 0.29, bestAskSize: 100, t: t0 + 30 });

    await new Promise((r) => setTimeout(r, 600));
    paper.end();

    const shock = rows.find((r) => r.kind === "paper_middle_shock") as any;
    expect(shock).toBeTruthy();
    expect(shock.wouldFire).toBeGreaterThanOrEqual(1);
    expect(shock.hits[0].lineFamily).toBe("2.5-3.5");
    expect(paper.stats.wouldFire).toBeGreaterThanOrEqual(1);
  });
});

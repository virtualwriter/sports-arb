import { describe, expect, it } from "vitest";
import type { Candidate, MarketQuote } from "./monotonic-arb-core.js";
import {
  backtestLineFamily,
  backtestMiddleWidth,
  evMarginMaxCost,
  loadSportsBacktestPositiveShapes,
  resetSportsBacktestShapeCacheForTests,
  sportsBacktestLiveGateBlock,
} from "./soccer-backtest-live-gate.js";

function quote(overrides: Partial<MarketQuote>): MarketQuote {
  return {
    eventSlug: "fifwc-prt-esp-2026-07-06-more-markets",
    eventTitle: "Portugal vs. Spain",
    marketId: "m1",
    ladderKey: "sports:soccer:fifwc-prt-esp-2026-07-06-more-markets:total:full-game",
    question: "Portugal vs. Spain: O/U 3.5",
    description: "",
    resolutionSource: "",
    strike: 3.5,
    direction: "above",
    startDate: null,
    endDate: null,
    liquidity: 100,
    yesTokenId: "yes1",
    noTokenId: "no1",
    yesBook: { tokenId: "yes1", bid: 0.5, bidSize: 20, ask: 0.5, askSize: 20, spread: 0.01, minOrderSize: 1 },
    noBook: { tokenId: "no1", bid: 0.4, bidSize: 20, ask: 0.5, askSize: 20, spread: 0.01, minOrderSize: 1 },
    ...overrides,
  };
}

function soccerCandidate(overrides: Partial<Candidate> = {}): Candidate {
  const broad = quote({ strike: 3.5, question: "Portugal vs. Spain: O/U 3.5" });
  const narrow = quote({
    strike: 4.5,
    question: "Portugal vs. Spain: O/U 4.5",
    noBook: { tokenId: "no-narrow", bid: 0.9, bidSize: 20, ask: 0.504, askSize: 20, spread: 0.01, minOrderSize: 1 },
  });
  return {
    foundAt: new Date().toISOString(),
    asset: "SOCCER",
    eventSlug: "fifwc-prt-esp-2026-07-06-more-markets",
    eventTitle: "Portugal vs. Spain",
    packageId: "pkg",
    direction: "above",
    broad,
    narrow,
    packageCost: 1.004,
    lockedEdge: -0.4,
    availableSize: 200,
    maxSpread: 0.01,
    minLiquidity: 100,
    jackpotPayoutPerShare: 2,
    eligible: true,
    rejectionReasons: [],
    ...overrides,
  };
}

describe("soccer backtest live gate", () => {
  it("normalizes spread families to signed backtest keys", () => {
    const broad = quote({
      ladderKey: "sports:soccer:fifwc-prt-esp-2026-07-06-more-markets:spread:full-game:esp",
      question: "Spread: Spain (-1.5)",
      strike: 1.5,
    });
    const narrow = quote({
      ladderKey: "sports:soccer:fifwc-prt-esp-2026-07-06-more-markets:spread:full-game:esp",
      question: "Spread: Spain (-3.5)",
      strike: 3.5,
    });
    expect(backtestLineFamily({ broad, narrow } as Candidate, "spread")).toBe("-3.5--1.5");
    expect(backtestMiddleWidth({ broad, narrow } as Candidate)).toBe(2);
  });

  it("allows backtest-positive 3.5-4.5 match totals at cheap costs", () => {
    resetSportsBacktestShapeCacheForTests();
    const shapes = loadSportsBacktestPositiveShapes();
    expect(shapes.has("SOCCER|match_total|3.5-4.5|w1")).toBe(true);
    expect(sportsBacktestLiveGateBlock(soccerCandidate(), "match_total")).toBeNull();
  });

  it("loads MLB shapes under the same positive-ROI rule", () => {
    resetSportsBacktestShapeCacheForTests();
    const shapes = loadSportsBacktestPositiveShapes();
    const mlb = [...shapes.values()].filter((s) => s.asset === "MLB");
    expect(mlb.length).toBeGreaterThan(0);
    expect(mlb.every((s) => s.worstRoiPct > 0)).toBe(true);
    expect(shapes.has("MLB|spread|-2.5--1.5|w1")).toBe(true);
  });

  it("caps every live cost at the EV-margin price", () => {
    resetSportsBacktestShapeCacheForTests();
    const shapes = loadSportsBacktestPositiveShapes();
    for (const shape of shapes.values()) {
      expect(shape.maxLiveCost).toBeLessThanOrEqual(shape.worstAvgCost + 1e-9);
      expect(shape.maxLiveCost).toBeLessThanOrEqual(evMarginMaxCost(shape.middleRate) + 1e-9);
    }
  });

  it("blocks 4.5-5.5 match totals with negative backtest ROI@worst", () => {
    resetSportsBacktestShapeCacheForTests();
    const broad = quote({ strike: 4.5, question: "Portugal vs. Spain: O/U 4.5" });
    const narrow = quote({ strike: 5.5, question: "Portugal vs. Spain: O/U 5.5" });
    const block = sportsBacktestLiveGateBlock(
      soccerCandidate({ broad, narrow, packageCost: 1.005 }),
      "match_total",
    );
    expect(block).toMatch(/sports_backtest_shape_not_positive/);
  });

  it("blocks costs above the EV-margin ceiling for a shape", () => {
    resetSportsBacktestShapeCacheForTests();
    const block = sportsBacktestLiveGateBlock(soccerCandidate({ packageCost: 1.25 }), "match_total");
    expect(block).toMatch(/sports_backtest_cost_above_ev_cap/);
  });
});

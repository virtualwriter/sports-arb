import { describe, expect, it } from "vitest";
import type { Candidate, MarketQuote } from "./monotonic-arb-core.js";
import { evaluateSportsStrategy } from "./sports-strategy.js";

function quote(overrides: Partial<MarketQuote>): MarketQuote {
  return {
    eventSlug: "mlb-yankees-red-sox",
    eventTitle: "Yankees vs. Red Sox",
    marketId: "m1",
    ladderKey: "sports:mlb:total:full-game",
    question: "Yankees vs. Red Sox: O/U 7.5",
    description: "",
    resolutionSource: "",
    strike: 5.5,
    direction: "above",
    startDate: null,
    endDate: null,
    liquidity: 100,
    yesTokenId: "yes1",
    noTokenId: "no1",
    yesBook: { tokenId: "yes1", bid: 0.5, bidSize: 20, ask: 0.6, askSize: 20, spread: 0.01, minOrderSize: 1 },
    noBook: { tokenId: "no1", bid: 0.4, bidSize: 20, ask: 0.5, askSize: 20, spread: 0.01, minOrderSize: 1 },
    ...overrides,
  };
}

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  const broad = quote({ strike: 5.5, marketId: "broad", yesTokenId: "yes-broad" });
  const narrow = quote({ strike: 7.5, marketId: "narrow", noTokenId: "no-narrow" });
  return {
    foundAt: new Date().toISOString(),
    asset: "MLB",
    eventSlug: "mlb-yankees-red-sox",
    eventTitle: "Yankees vs. Red Sox",
    packageId: "pkg",
    direction: "above",
    broad,
    narrow,
    packageCost: 1.2,
    lockedEdge: -0.2,
    availableSize: 20,
    maxSpread: 0.01,
    minLiquidity: 100,
    jackpotPayoutPerShare: 2,
    eligible: true,
    rejectionReasons: [],
    ...overrides,
  };
}

function soccerCandidate(overrides: Partial<Candidate> = {}): Candidate {
  const broad = quote({
    eventSlug: "fifwc-che-can-2026-06-24-more-markets",
    eventTitle: "Switzerland vs. Canada",
    marketId: "soccer-broad",
    ladderKey: "sports:soccer:fifwc-che-can-2026-06-24-more-markets:total:full-game",
    question: "Switzerland vs. Canada: O/U 2.5",
    strike: 2.5,
    yesBook: { tokenId: "yes-broad", bid: 0.3, bidSize: 20, ask: 0.25, askSize: 20, spread: 0.01, minOrderSize: 1 },
  });
  const narrow = quote({
    eventSlug: "fifwc-che-can-2026-06-24-more-markets",
    eventTitle: "Switzerland vs. Canada",
    marketId: "soccer-narrow",
    ladderKey: "sports:soccer:fifwc-che-can-2026-06-24-more-markets:total:full-game",
    question: "Switzerland vs. Canada: O/U 5.5",
    strike: 5.5,
    noTokenId: "no-narrow",
    noBook: { tokenId: "no-narrow", bid: 0.9, bidSize: 20, ask: 0.93, askSize: 20, spread: 0.01, minOrderSize: 1 },
  });
  return {
    ...candidate({
      asset: "SOCCER",
      eventSlug: "fifwc-che-can-2026-06-24-more-markets",
      eventTitle: "Switzerland vs. Canada",
      broad,
      narrow,
      packageCost: 1.18,
    }),
    ...overrides,
  };
}

describe("sports strategy", () => {
  it("allows the tight MLB 5.5-7.5 live bucket", () => {
    const decision = evaluateSportsStrategy(candidate());
    expect(decision.liveEligible).toBe(true);
    expect(decision.costBucket).toBe("1.190-1.220");
  });

  it("allows soccer match totals without strategy-layer cost or family gates", () => {
    const decision = evaluateSportsStrategy(soccerCandidate({ packageCost: 1.31 }));
    expect(decision.liveEligible).toBe(true);
    expect(decision.marketType).toBe("match_total");
    expect(decision.lineFamily).toBe("2.5-5.5");
    expect(decision.middleWidth).toBe(3);
    expect(decision.gateFailures).not.toContain("soccer_total_family_max_cost_exceeded");
  });

  it("allows soccer spreads at the strategy layer", () => {
    const broad = quote({
      eventSlug: "fifwc-che-can-2026-06-24-more-markets",
      ladderKey: "sports:soccer:fifwc-che-can-2026-06-24-more-markets:spread:full-game:canada",
      question: "Spread: Canada (-1.5)",
      strike: 1.5,
      yesBook: { tokenId: "yes-broad", bid: 0.3, bidSize: 20, ask: 0.25, askSize: 20, spread: 0.01, minOrderSize: 1 },
    });
    const narrow = quote({
      eventSlug: "fifwc-che-can-2026-06-24-more-markets",
      ladderKey: "sports:soccer:fifwc-che-can-2026-06-24-more-markets:spread:full-game:canada",
      question: "Spread: Canada (-3.5)",
      strike: 3.5,
      noBook: { tokenId: "no-narrow", bid: 0.9, bidSize: 20, ask: 0.93, askSize: 20, spread: 0.01, minOrderSize: 1 },
    });
    const decision = evaluateSportsStrategy(soccerCandidate({ broad, narrow, packageCost: 1.18 }));
    expect(decision.liveEligible).toBe(true);
    expect(decision.marketType).toBe("spread");
  });

  it("blocks unsupported soccer market types", () => {
    const broad = quote({
      eventSlug: "fifwc-che-can-2026-06-24-more-markets",
      ladderKey: "sports:soccer:fifwc-che-can-2026-06-24-more-markets:total:team",
      question: "Switzerland: team-total O/U 1.5",
      strike: 1.5,
      yesBook: { tokenId: "yes-broad", bid: 0.3, bidSize: 20, ask: 0.25, askSize: 20, spread: 0.01, minOrderSize: 1 },
    });
    const narrow = quote({
      eventSlug: "fifwc-che-can-2026-06-24-more-markets",
      ladderKey: "sports:soccer:fifwc-che-can-2026-06-24-more-markets:total:team",
      question: "Switzerland: team-total O/U 2.5",
      strike: 2.5,
      noBook: { tokenId: "no-narrow", bid: 0.9, bidSize: 20, ask: 0.93, askSize: 20, spread: 0.01, minOrderSize: 1 },
    });
    const decision = evaluateSportsStrategy(soccerCandidate({ broad, narrow, packageCost: 1.18 }));
    expect(decision.liveEligible).toBe(false);
    expect(decision.gateFailures).toContain("soccer_market_shape_not_live");
  });
});

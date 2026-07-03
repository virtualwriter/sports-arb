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

  it("allows the lower-cost MLB 6.5-7.5 live bucket", () => {
    const broad = quote({ strike: 6.5, marketId: "broad", yesTokenId: "yes-broad" });
    const narrow = quote({ strike: 7.5, marketId: "narrow", noTokenId: "no-narrow" });
    const decision = evaluateSportsStrategy(candidate({ broad, narrow, packageCost: 1.12 }));
    expect(decision.liveEligible).toBe(true);
    expect(decision.lineFamily).toBe("6.5-7.5");
    expect(decision.costBucket).toBe("1.100-1.160");
  });

  it("allows the lower-cost MLB 6.5-8.5 live bucket", () => {
    const broad = quote({ strike: 6.5, marketId: "broad", yesTokenId: "yes-broad" });
    const narrow = quote({ strike: 8.5, marketId: "narrow", noTokenId: "no-narrow" });
    const decision = evaluateSportsStrategy(candidate({ broad, narrow, packageCost: 1.18 }));
    expect(decision.liveEligible).toBe(true);
    expect(decision.lineFamily).toBe("6.5-8.5");
    expect(decision.costBucket).toBe("1.160-1.190");
  });

  it("blocks MLB 6.5-8.5 in the old high-cost bucket", () => {
    const broad = quote({ strike: 6.5, marketId: "broad", yesTokenId: "yes-broad" });
    const narrow = quote({ strike: 8.5, marketId: "narrow", noTokenId: "no-narrow" });
    const decision = evaluateSportsStrategy(candidate({ broad, narrow, packageCost: 1.20 }));
    expect(decision.liveEligible).toBe(false);
    expect(decision.gateFailures).toContain("mlb_cost_bucket_not_live");
  });

  it("blocks MLB total families outside the tight ROI rule", () => {
    const broad = quote({ strike: 7.5, marketId: "broad", yesTokenId: "yes-broad" });
    const narrow = quote({ strike: 9.5, marketId: "narrow", noTokenId: "no-narrow" });
    const decision = evaluateSportsStrategy(candidate({ broad, narrow, packageCost: 1.18 }));
    expect(decision.liveEligible).toBe(false);
    expect(decision.gateFailures).toContain("mlb_total_line_family_not_preferred");
  });

  it("captures sub-1 packages as universal shadows", () => {
    const decision = evaluateSportsStrategy(candidate({ packageCost: 0.99 }));
    expect(decision.shadowEligible).toBe(true);
    expect(decision.shadowPurpose).toBe("sub_1_universal_capture");
  });

  it("keeps new sports shadow-only", () => {
    const base = candidate({ eventSlug: "wnba-aces-liberty", asset: "WNBA" });
    base.broad.eventSlug = "wnba-aces-liberty";
    base.narrow.eventSlug = "wnba-aces-liberty";
    const decision = evaluateSportsStrategy(base);
    expect(decision.liveEligible).toBe(false);
    expect(decision.gateFailures).toContain("adapter_shadow_only");
  });

  it("allows historical-winner full-game soccer match totals", () => {
    const decision = evaluateSportsStrategy(soccerCandidate());
    expect(decision.liveEligible).toBe(true);
    expect(decision.marketType).toBe("match_total");
    expect(decision.lineFamily).toBe("2.5-5.5");
    expect(decision.middleWidth).toBe(3);
  });

  it("allows the 2.5-6.5 width-4 soccer match total family", () => {
    const broad = quote({
      eventSlug: "fifwc-che-can-2026-06-24-more-markets",
      ladderKey: "sports:soccer:fifwc-che-can-2026-06-24-more-markets:total:full-game",
      question: "Switzerland vs. Canada: O/U 2.5",
      strike: 2.5,
      yesBook: { tokenId: "yes-broad", bid: 0.3, bidSize: 20, ask: 0.25, askSize: 20, spread: 0.01, minOrderSize: 1 },
    });
    const narrow = quote({
      eventSlug: "fifwc-che-can-2026-06-24-more-markets",
      ladderKey: "sports:soccer:fifwc-che-can-2026-06-24-more-markets:total:full-game",
      question: "Switzerland vs. Canada: O/U 6.5",
      strike: 6.5,
      noTokenId: "no-narrow",
      noBook: { tokenId: "no-narrow", bid: 0.9, bidSize: 20, ask: 0.93, askSize: 20, spread: 0.01, minOrderSize: 1 },
    });
    const decision = evaluateSportsStrategy(soccerCandidate({ broad, narrow, packageCost: 1.18 }));
    expect(decision.liveEligible).toBe(true);
    expect(decision.lineFamily).toBe("2.5-6.5");
    expect(decision.middleWidth).toBe(4);
  });

  it("blocks 3.5-6.5 above the live family max cost", () => {
    const broad = quote({
      eventSlug: "fifwc-civ-nor-2026-06-30-more-markets",
      ladderKey: "sports:soccer:fifwc-civ-nor-2026-06-30-more-markets:total:full-game",
      question: "Côte d'Ivoire vs. Norway: O/U 3.5",
      strike: 3.5,
      yesBook: { tokenId: "yes-broad", bid: 0.3, bidSize: 20, ask: 0.35, askSize: 20, spread: 0.01, minOrderSize: 1 },
    });
    const narrow = quote({
      eventSlug: "fifwc-civ-nor-2026-06-30-more-markets",
      ladderKey: "sports:soccer:fifwc-civ-nor-2026-06-30-more-markets:total:full-game",
      question: "Côte d'Ivoire vs. Norway: O/U 6.5",
      strike: 6.5,
      noTokenId: "no-narrow",
      noBook: { tokenId: "no-narrow", bid: 0.9, bidSize: 20, ask: 0.93, askSize: 20, spread: 0.01, minOrderSize: 1 },
    });
    const decision = evaluateSportsStrategy(soccerCandidate({ broad, narrow, packageCost: 1.278 }));
    expect(decision.liveEligible).toBe(false);
    expect(decision.gateFailures).toContain("soccer_total_family_max_cost_exceeded");
  });

  it("allows 3.5-6.5 at or below the live family max cost", () => {
    const broad = quote({
      eventSlug: "fifwc-civ-nor-2026-06-30-more-markets",
      ladderKey: "sports:soccer:fifwc-civ-nor-2026-06-30-more-markets:total:full-game",
      question: "Côte d'Ivoire vs. Norway: O/U 3.5",
      strike: 3.5,
      yesBook: { tokenId: "yes-broad", bid: 0.3, bidSize: 20, ask: 0.35, askSize: 20, spread: 0.01, minOrderSize: 1 },
    });
    const narrow = quote({
      eventSlug: "fifwc-civ-nor-2026-06-30-more-markets",
      ladderKey: "sports:soccer:fifwc-civ-nor-2026-06-30-more-markets:total:full-game",
      question: "Côte d'Ivoire vs. Norway: O/U 6.5",
      strike: 6.5,
      noTokenId: "no-narrow",
      noBook: { tokenId: "no-narrow", bid: 0.9, bidSize: 20, ask: 0.91, askSize: 20, spread: 0.01, minOrderSize: 1 },
    });
    const decision = evaluateSportsStrategy(soccerCandidate({ broad, narrow, packageCost: 1.20 }));
    expect(decision.liveEligible).toBe(true);
    expect(decision.lineFamily).toBe("3.5-6.5");
  });

  it("blocks 3.5-5.5 above the live family max cost", () => {
    const broad = quote({
      eventSlug: "fifwc-arg-cvi-2026-07-03-more-markets",
      ladderKey: "sports:soccer:fifwc-arg-cvi-2026-07-03-more-markets:total:full-game",
      question: "Argentina vs. Cabo Verde: O/U 3.5",
      strike: 3.5,
      yesBook: { tokenId: "yes-broad", bid: 0.3, bidSize: 20, ask: 0.35, askSize: 20, spread: 0.01, minOrderSize: 1 },
    });
    const narrow = quote({
      eventSlug: "fifwc-arg-cvi-2026-07-03-more-markets",
      ladderKey: "sports:soccer:fifwc-arg-cvi-2026-07-03-more-markets:total:full-game",
      question: "Argentina vs. Cabo Verde: O/U 5.5",
      strike: 5.5,
      noTokenId: "no-narrow",
      noBook: { tokenId: "no-narrow", bid: 0.9, bidSize: 20, ask: 0.93, askSize: 20, spread: 0.01, minOrderSize: 1 },
    });
    const decision = evaluateSportsStrategy(soccerCandidate({ broad, narrow, packageCost: 1.27 }));
    expect(decision.liveEligible).toBe(false);
    expect(decision.gateFailures).toContain("soccer_total_family_max_cost_exceeded");
  });

  it("allows 3.5-5.5 at or below the live family max cost", () => {
    const broad = quote({
      eventSlug: "fifwc-arg-cvi-2026-07-03-more-markets",
      ladderKey: "sports:soccer:fifwc-arg-cvi-2026-07-03-more-markets:total:full-game",
      question: "Argentina vs. Cabo Verde: O/U 3.5",
      strike: 3.5,
      yesBook: { tokenId: "yes-broad", bid: 0.3, bidSize: 20, ask: 0.30, askSize: 20, spread: 0.01, minOrderSize: 1 },
    });
    const narrow = quote({
      eventSlug: "fifwc-arg-cvi-2026-07-03-more-markets",
      ladderKey: "sports:soccer:fifwc-arg-cvi-2026-07-03-more-markets:total:full-game",
      question: "Argentina vs. Cabo Verde: O/U 5.5",
      strike: 5.5,
      noTokenId: "no-narrow",
      noBook: { tokenId: "no-narrow", bid: 0.9, bidSize: 20, ask: 0.93, askSize: 20, spread: 0.01, minOrderSize: 1 },
    });
    const decision = evaluateSportsStrategy(soccerCandidate({ broad, narrow, packageCost: 1.18 }));
    expect(decision.gateFailures).not.toContain("soccer_total_family_max_cost_exceeded");
    expect(decision.liveEligible).toBe(true);
    expect(decision.lineFamily).toBe("3.5-5.5");
  });

  it("blocks 2.5-4.5 above the live family max cost in T3", () => {
    const broad = quote({
      eventSlug: "fifwc-mex-ecu-2026-06-30-more-markets",
      ladderKey: "sports:soccer:fifwc-mex-ecu-2026-06-30-more-markets:total:full-game",
      question: "Mexico vs. Ecuador: O/U 2.5",
      strike: 2.5,
      yesBook: { tokenId: "yes-broad", bid: 0.3, bidSize: 20, ask: 0.37, askSize: 20, spread: 0.01, minOrderSize: 1 },
    });
    const narrow = quote({
      eventSlug: "fifwc-mex-ecu-2026-06-30-more-markets",
      ladderKey: "sports:soccer:fifwc-mex-ecu-2026-06-30-more-markets:total:full-game",
      question: "Mexico vs. Ecuador: O/U 4.5",
      strike: 4.5,
      noTokenId: "no-narrow",
      noBook: { tokenId: "no-narrow", bid: 0.9, bidSize: 20, ask: 0.93, askSize: 20, spread: 0.01, minOrderSize: 1 },
    });
    const decision = evaluateSportsStrategy(soccerCandidate({ broad, narrow, packageCost: 1.30 }));
    expect(decision.liveEligible).toBe(false);
    expect(decision.gateFailures).toContain("soccer_total_family_max_cost_exceeded");
  });

  it("still blocks unsupported soccer match total widths (width 5)", () => {
    const broad = quote({
      eventSlug: "fifwc-che-can-2026-06-24-more-markets",
      ladderKey: "sports:soccer:fifwc-che-can-2026-06-24-more-markets:total:full-game",
      question: "Switzerland vs. Canada: O/U 2.5",
      strike: 2.5,
      yesBook: { tokenId: "yes-broad", bid: 0.3, bidSize: 20, ask: 0.25, askSize: 20, spread: 0.01, minOrderSize: 1 },
    });
    const narrow = quote({
      eventSlug: "fifwc-che-can-2026-06-24-more-markets",
      ladderKey: "sports:soccer:fifwc-che-can-2026-06-24-more-markets:total:full-game",
      question: "Switzerland vs. Canada: O/U 7.5",
      strike: 7.5,
      noTokenId: "no-narrow",
      noBook: { tokenId: "no-narrow", bid: 0.9, bidSize: 20, ask: 0.93, askSize: 20, spread: 0.01, minOrderSize: 1 },
    });
    const decision = evaluateSportsStrategy(soccerCandidate({ broad, narrow, packageCost: 1.18 }));
    expect(decision.gateFailures).toContain("soccer_total_width_not_historical_winner");
  });

  it("allows strict soccer match totals in the selective high-cost bucket", () => {
    const decision = evaluateSportsStrategy(soccerCandidate({ packageCost: 1.31 }));
    expect(decision.liveEligible).toBe(true);
    expect(decision.costBucket).toBe("1.250-1.350");
  });

  it("allows historical-winner full-game soccer spreads", () => {
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
    expect(decision.middleWidth).toBe(2);
  });

  it("keeps high-cost soccer spreads out of live entry", () => {
    const broad = quote({
      eventSlug: "fifwc-che-can-2026-06-24-more-markets",
      ladderKey: "sports:soccer:fifwc-che-can-2026-06-24-more-markets:spread:full-game:canada",
      question: "Spread: Canada (-1.5)",
      strike: 1.5,
      yesBook: { tokenId: "yes-broad", bid: 0.3, bidSize: 20, ask: 0.36, askSize: 20, spread: 0.01, minOrderSize: 1 },
    });
    const narrow = quote({
      eventSlug: "fifwc-che-can-2026-06-24-more-markets",
      ladderKey: "sports:soccer:fifwc-che-can-2026-06-24-more-markets:spread:full-game:canada",
      question: "Spread: Canada (-3.5)",
      strike: 3.5,
      noBook: { tokenId: "no-narrow", bid: 0.9, bidSize: 20, ask: 0.94, askSize: 20, spread: 0.01, minOrderSize: 1 },
    });
    const decision = evaluateSportsStrategy(soccerCandidate({ broad, narrow, packageCost: 1.30 }));
    expect(decision.liveEligible).toBe(false);
    expect(decision.gateFailures).toContain("soccer_cost_bucket_not_live");
  });

  it("blocks one-goal soccer spread near misses from live entry", () => {
    const broad = quote({
      eventSlug: "fifwc-che-can-2026-06-24-more-markets",
      ladderKey: "sports:soccer:fifwc-che-can-2026-06-24-more-markets:spread:full-game:canada",
      question: "Spread: Canada (-1.5)",
      strike: 1.5,
      yesBook: { tokenId: "yes-broad", bid: 0.3, bidSize: 20, ask: 0.17, askSize: 20, spread: 0.01, minOrderSize: 1 },
    });
    const narrow = quote({
      eventSlug: "fifwc-che-can-2026-06-24-more-markets",
      ladderKey: "sports:soccer:fifwc-che-can-2026-06-24-more-markets:spread:full-game:canada",
      question: "Spread: Canada (-2.5)",
      strike: 2.5,
      noBook: { tokenId: "no-narrow", bid: 0.9, bidSize: 20, ask: 0.93, askSize: 20, spread: 0.01, minOrderSize: 1 },
    });
    const decision = evaluateSportsStrategy(soccerCandidate({ broad, narrow, packageCost: 1.10 }));
    expect(decision.liveEligible).toBe(false);
    expect(decision.shadowPurpose).toBe("excluded_shape_probe");
    expect(decision.gateFailures).toContain("soccer_spread_width_not_historical_winner");
  });

  it("blocks first-half soccer totals from live entry", () => {
    const broad = quote({
      eventSlug: "fifwc-che-can-2026-06-24-more-markets",
      ladderKey: "sports:soccer:fifwc-che-can-2026-06-24-more-markets:total:first-half",
      question: "Switzerland vs. Canada: 1st Half O/U 1.5",
      strike: 1.5,
      yesBook: { tokenId: "yes-broad", bid: 0.3, bidSize: 20, ask: 0.25, askSize: 20, spread: 0.01, minOrderSize: 1 },
    });
    const narrow = quote({
      eventSlug: "fifwc-che-can-2026-06-24-more-markets",
      ladderKey: "sports:soccer:fifwc-che-can-2026-06-24-more-markets:total:first-half",
      question: "Switzerland vs. Canada: 1st Half O/U 3.5",
      strike: 3.5,
      noBook: { tokenId: "no-narrow", bid: 0.9, bidSize: 20, ask: 0.93, askSize: 20, spread: 0.01, minOrderSize: 1 },
    });
    const decision = evaluateSportsStrategy(soccerCandidate({ broad, narrow, packageCost: 1.18 }));
    expect(decision.liveEligible).toBe(false);
    expect(decision.gateFailures).toContain("soccer_total_not_full_game");
  });
});

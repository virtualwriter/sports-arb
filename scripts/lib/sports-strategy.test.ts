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

describe("sports strategy", () => {
  it("allows the preferred MLB live bucket", () => {
    const decision = evaluateSportsStrategy(candidate());
    expect(decision.liveEligible).toBe(true);
    expect(decision.costBucket).toBe("1.190-1.220");
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
});

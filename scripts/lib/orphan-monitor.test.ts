import { describe, expect, it } from "vitest";
import { packageFromCandidate } from "./package-factory.js";
import { checkOrphan } from "./orphan-monitor.js";
import { evaluateSportsStrategy } from "./sports-strategy.js";
import type { Candidate, MarketQuote } from "./monotonic-arb-core.js";

function quote(strike: number, size: number): MarketQuote {
  return {
    eventSlug: "mlb-yankees-red-sox",
    eventTitle: "Yankees vs. Red Sox",
    marketId: `m${strike}`,
    ladderKey: "sports:mlb:total:full-game",
    question: "Yankees vs. Red Sox: O/U 7.5",
    description: "",
    resolutionSource: "",
    strike,
    direction: "above",
    startDate: null,
    endDate: null,
    liquidity: 100,
    yesTokenId: `yes${strike}`,
    noTokenId: `no${strike}`,
    yesBook: { tokenId: `yes${strike}`, bid: 0.5, bidSize: size, ask: 0.6, askSize: size, spread: 0.01, minOrderSize: 1 },
    noBook: { tokenId: `no${strike}`, bid: 0.4, bidSize: size, ask: 0.5, askSize: size, spread: 0.01, minOrderSize: 1 },
  };
}

describe("orphan monitor", () => {
  it("treats large orphan exposure as a pause condition", () => {
    const candidate: Candidate = {
      foundAt: new Date().toISOString(),
      asset: "MLB",
      eventSlug: "mlb-yankees-red-sox",
      eventTitle: "Yankees vs. Red Sox",
      packageId: "pkg",
      direction: "above",
      broad: quote(5.5, 20),
      narrow: quote(7.5, 17),
      packageCost: 1.2,
      lockedEdge: -0.2,
      availableSize: 20,
      maxSpread: 0.01,
      minLiquidity: 100,
      jackpotPayoutPerShare: 2,
      eligible: true,
      rejectionReasons: [],
    };
    const item = packageFromCandidate({ candidate, decision: evaluateSportsStrategy(candidate), mode: "live", targetUsd: 20, maxPackageUsd: 20, metadataSnapshotId: "snap" });
    const check = checkOrphan(item, 1);
    expect(check.severity).toBe("large");
    expect(check.shouldPause).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { packageFromCandidate } from "./package-factory.js";
import { markLifecycle } from "./order-lifecycle.js";
import { evaluateSportsStrategy } from "./sports-strategy.js";
import type { Candidate, MarketQuote } from "./monotonic-arb-core.js";

function quote(strike: number): MarketQuote {
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
    yesBook: { tokenId: `yes${strike}`, bid: 0.5, bidSize: 20, ask: 0.6, askSize: 20, spread: 0.01, minOrderSize: 1 },
    noBook: { tokenId: `no${strike}`, bid: 0.4, bidSize: 20, ask: 0.5, askSize: 20, spread: 0.01, minOrderSize: 1 },
  };
}

function pkg() {
  const candidate: Candidate = {
    foundAt: "2026-06-23T00:00:00.000Z",
    asset: "MLB",
    eventSlug: "mlb-yankees-red-sox",
    eventTitle: "Yankees vs. Red Sox",
    packageId: "pkg",
    direction: "above",
    broad: quote(5.5),
    narrow: quote(7.5),
    packageCost: 1.2,
    lockedEdge: -0.2,
    availableSize: 20,
    maxSpread: 0.01,
    minLiquidity: 100,
    jackpotPayoutPerShare: 2,
    eligible: true,
    rejectionReasons: [],
  };
  return packageFromCandidate({ candidate, decision: evaluateSportsStrategy(candidate), mode: "live", targetUsd: 20, maxPackageUsd: 20, metadataSnapshotId: "snap" });
}

describe("order lifecycle", () => {
  it("records millisecond deltas between lifecycle marks", () => {
    let item = pkg();
    const created = Date.parse(item.timestamps.created ?? "");
    item = markLifecycle(item, "qualified", created + 7);
    item = markLifecycle(item, "preflight_started", created + 12);
    expect(item.lifecycleMs.qualified).toBe(7);
    expect(item.lifecycleMs.preflight_started).toBe(5);
  });
});

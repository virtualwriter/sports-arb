import { describe, expect, it, beforeEach } from "vitest";
import type { Candidate } from "./monotonic-arb-core.js";
import {
  recordSoccerEventShapeCost,
  resetSoccerEventBestCosts,
  soccerBestSeenCostBlock,
} from "./soccer-event-best-cost.js";

function soccerCandidate(cost: number): Candidate {
  return {
    asset: "SOCCER",
    eventSlug: "fifwc-arg-cvi-2026-07-03-more-markets",
    packageCost: cost,
    broad: { strike: 3.5 } as Candidate["broad"],
    narrow: { strike: 5.5 } as Candidate["narrow"],
  } as Candidate;
}

describe("soccer-event-best-cost", () => {
  beforeEach(() => resetSoccerEventBestCosts());

  it("blocks when cost is above best seen plus tolerance", () => {
    recordSoccerEventShapeCost(soccerCandidate(1.12));
    expect(soccerBestSeenCostBlock(soccerCandidate(1.15))).toBeNull();
    expect(soccerBestSeenCostBlock(soccerCandidate(1.16))).toMatch(/soccer_above_best_seen/);
  });
});

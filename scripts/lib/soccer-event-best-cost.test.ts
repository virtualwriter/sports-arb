import { describe, expect, it, beforeAll, beforeEach } from "vitest";
import type { Candidate } from "./monotonic-arb-core.js";

// The gate reads its enable flag at module load, so set env before importing.
process.env.ARB_DAEMON_SOCCER_BEST_SEEN_GATE = "1";
const gate = await import("./soccer-event-best-cost.js");

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
  beforeAll(() => {
    expect(gate.SOCCER_BEST_SEEN_GATE_ENABLED).toBe(true);
  });
  beforeEach(() => gate.resetSoccerEventBestCosts());

  it("blocks when cost is above best seen plus tolerance", () => {
    gate.recordSoccerEventShapeCost(soccerCandidate(1.12));
    expect(gate.soccerBestSeenCostBlock(soccerCandidate(1.15))).toBeNull();
    expect(gate.soccerBestSeenCostBlock(soccerCandidate(1.16))).toMatch(/soccer_above_best_seen/);
  });
});

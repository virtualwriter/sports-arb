import { describe, expect, it } from "vitest";
import { PATHS } from "./paths.js";
import {
  basesKeyFromFlags,
  bestStrat2BranchEdge,
  expectedEdgeUnderPaPriors,
  loadPaRbiPriors,
  lookupPaRbiP,
  scoringDeltaWeights,
} from "./mlb-pa-rbi-priors.js";

describe("mlb PA RBI priors", () => {
  it("loads repo backtest artifact", () => {
    const priors = loadPaRbiPriors(PATHS.mlbPaRbiPriors);
    expect(priors).toBeTruthy();
    expect(priors!.totalPlateAppearances).toBeGreaterThan(100_000);
    expect(priors!.byOutsBases.size).toBeGreaterThan(10);
  });

  it("basesKeyFromFlags matches backtest cells", () => {
    expect(basesKeyFromFlags(true, true, false)).toBe("12-");
    expect(basesKeyFromFlags(true, false, true)).toBe("1-3");
    expect(basesKeyFromFlags(false, false, false)).toBe("---");
  });

  it("looks up outs×bases and renormalizes scoring weights", () => {
    const priors = loadPaRbiPriors(PATHS.mlbPaRbiPriors)!;
    const hit = lookupPaRbiP(priors, {
      outs: 2,
      onFirst: true,
      onSecond: true,
      onThird: false,
      runnersOn: 2,
    });
    expect(hit.source).toBe("outs_bases");
    expect(hit.bases).toBe("12-");
    expect(hit.cellN).toBeGreaterThan(0);
    expect(hit.p[0] + hit.p[1] + hit.p[2] + hit.p[3] + hit.p[4]).toBeCloseTo(1, 5);

    const w = scoringDeltaWeights(hit.p, [1, 2, 3]);
    const sum = (w[1] ?? 0) + (w[2] ?? 0) + (w[3] ?? 0);
    expect(sum).toBeCloseTo(1, 5);
    expect(w[1]).toBeGreaterThan(w[3] ?? 0);
  });

  it("computes PA expected edge vs best Strat2 branch", () => {
    const weights = { 1: 0.7, 2: 0.25, 3: 0.05 };
    const branches = [
      { rbiDelta: 1, fair: 1.55, cost: 1.4 },
      { rbiDelta: 2, fair: 1.7, cost: 1.4 },
      { rbiDelta: 3, fair: 1.9, cost: 1.4 },
    ];
    const exp = expectedEdgeUnderPaPriors(weights, branches);
    expect(exp).toBeCloseTo(0.7 * 0.15 + 0.25 * 0.3 + 0.05 * 0.5, 8);

    const best = bestStrat2BranchEdge(branches);
    expect(best).toMatchObject({ rbiDelta: 3, edge: 0.5 });
  });
});

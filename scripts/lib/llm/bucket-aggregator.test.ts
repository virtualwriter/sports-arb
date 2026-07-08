import { describe, expect, it } from "vitest";
import { executionFlagFor } from "./bucket-aggregator.js";
import { loadBacktestShapeEvidence } from "./backtest-shape-evidence.js";
import { currentStrategyAllowlist } from "../sports-strategy.js";

describe("loadBacktestShapeEvidence", () => {
  it("loads soccer and MLB shapes; soccer enforcement is backtest-positive", () => {
    const shapes = loadBacktestShapeEvidence(currentStrategyAllowlist());
    expect(shapes.length).toBeGreaterThan(20);
    expect(shapes.some((s) => s.sportId === "MLB")).toBe(true);
    const soccerEnforced = shapes.filter((s) => s.sportId === "SOCCER" && s.enforcedLive);
    expect(soccerEnforced.length).toBeGreaterThan(20);
    // Soccer live gating is derived from backtest ROI; MLB enforcement comes
    // from the strategy allowlist and is not required to be ROI-positive.
    expect(soccerEnforced.every((s) => s.worstRoiPct > 0)).toBe(true);
    expect(soccerEnforced.some((s) => s.marketType === "spread")).toBe(true);
    expect(soccerEnforced.some((s) => s.lineFamily === "3.5-4.5")).toBe(true);
  });
});

describe("executionFlagFor", () => {
  const base = {
    sportId: "SOCCER",
    marketType: "match_total",
    lineFamily: "3.5-5.5",
    costBucket: "1.190-1.220",
    middleWidth: 2,
    comparisonGroup: "SOCCER:match_total:3.5-5.5:1.190-1.220",
    resolved: 31,
    wins: 10,
    losses: 21,
    middles: 5,
    totalCost: 100,
    totalPnl: -14,
    capitalWeightedRoiPct: -14,
    simpleAvgRoiPct: -14,
    winRate: 0.32,
    middleRate: 0.10,
    firstResolvedAt: null,
    lastResolvedAt: null,
    tier: "confirmed" as const,
    enforcedLive: true,
    avgFillSlippageCents: 0,
    avgPreflightDriftCents: 0,
    slippageSampleCount: 5,
    preflightDriftSampleCount: 5,
  };

  it("flags middle rate gap instead of demoting on live loss alone", () => {
    expect(executionFlagFor(base, 0.209)).toBe("middle_rate_gap");
  });

  it("flags slippage when fill drift is high", () => {
    expect(executionFlagFor({ ...base, avgFillSlippageCents: 8, middleRate: 0.25 }, 0.209))
      .toBe("slippage_concern");
  });

  it("does not treat negative live roi as a gate demote signal", () => {
    const flag = executionFlagFor(
      { ...base, avgFillSlippageCents: 1, middleRate: 0.18, slippageSampleCount: 3 },
      0.209,
    );
    expect(flag).not.toBe("demote_candidate" as never);
    expect(["middle_rate_gap", "execution_review", "hold"]).toContain(flag);
  });
});

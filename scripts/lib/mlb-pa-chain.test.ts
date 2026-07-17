import { afterEach, describe, expect, it } from "vitest";
import type { FeedSnapshot } from "./state-feed-map.js";
import {
  computeMlbBandState,
  computeMlbSpreadBandState,
  loadPaChainTable,
  paChainDistribution,
  paChainStateFromFeed,
  setPaChainTableForTests,
} from "./mlb-pa-chain.js";
import { PATHS } from "./paths.js";
import { computeStrat2State } from "./strat2-mlb-live-gate.js";

function feed(overrides: Partial<FeedSnapshot> = {}): FeedSnapshot {
  return {
    source: "statsapi",
    feedId: "1",
    live: true,
    scoreHome: 1,
    scoreAway: 3,
    period: "Bottom 8",
    outs: 2,
    clock: null,
    status: "Live",
    rawScoreKey: "3-1",
    runnersOn: 0,
    onFirst: false,
    onSecond: false,
    onThird: false,
    battingSide: "home",
    ...overrides,
  };
}

afterEach(() => setPaChainTableForTests(undefined));

describe("mlb PA chain", () => {
  it("loads the repo kernel artifact", () => {
    const table = loadPaChainTable(PATHS.mlbPaChainTransitions);
    expect(table).toBeTruthy();
    expect(table!.plateAppearances).toBeGreaterThan(100_000);
    expect(table!.cells.size).toBe(24);
    expect(table!.trainYear).toBe(2024);
  });

  it("parses feed into a sim state, advancing between-halves snapshots", () => {
    expect(paChainStateFromFeed(feed())).toMatchObject({
      inning: 8,
      half: "bottom",
      outs: 2,
      bases: "---",
    });
    expect(paChainStateFromFeed(feed({ period: "Middle 7", outs: 3 }))).toMatchObject({
      inning: 7,
      half: "bottom",
      outs: 0,
    });
    expect(paChainStateFromFeed(feed({ period: "Bottom 6", outs: 3 }))).toMatchObject({
      inning: 7,
      half: "top",
      outs: 0,
    });
    // Ambiguous period (bwin style) → null so callers fall back to Poisson.
    expect(paChainStateFromFeed(feed({ period: "8th Inning" }))).toBeNull();
  });

  it("regression: bot-8 2-out bases-empty 3-1 prices 4.5-5.5 near bwin, far below Poisson", () => {
    // Live NYM-PHI 2026-07-16: Strat2 Poisson said fair 1.36 (+9c "edge" on a
    // 1.27 package); devigged bwin said 1.20. The PA-chain backtest said 1.22.
    const state = computeMlbBandState(feed(), 4.5, 5.5);
    expect(state).toBeTruthy();
    expect(state!.model).toBe("pa_chain");
    expect(state!.fair).toBeGreaterThan(1.16);
    expect(state!.fair).toBeLessThan(1.27);

    const poisson = computeStrat2State(feed(), 4.5, 5.5);
    expect(poisson!.fair).toBeGreaterThan(1.33);
    expect(state!.fair).toBeLessThan(poisson!.fair - 0.08);
  });

  it("is deterministic for identical states", () => {
    const a = computeMlbBandState(feed(), 4.5, 5.5);
    const b = computeMlbBandState(feed(), 4.5, 5.5);
    expect(a!.pMiddle).toBe(b!.pMiddle);
  });

  it("handles walk-off terminal state (home already leading in bottom 9)", () => {
    const state = computeMlbBandState(
      feed({ period: "Bottom 9", scoreHome: 5, scoreAway: 3, outs: 1 }),
      7.5,
      8.5,
    );
    // Game over at total 8: middle (7.5, 8.5] locked.
    expect(state!.pMiddle).toBe(1);
    expect(state!.fair).toBe(2);
  });

  it("prices spread bands from the same distribution", () => {
    const state = computeMlbSpreadBandState(feed(), 1.5, 3.5, "away");
    expect(state).toBeTruthy();
    expect(state!.model).toBe("pa_chain");
    expect(state!.marketType).toBe("spread");
    // Away leads by 2 with ~1 inning left: margin very likely stays in (1.5, 3.5].
    expect(state!.pMiddle).toBeGreaterThan(0.5);
    expect(state!.pMiddle).toBeLessThan(0.95);
  });

  it("falls back to Poisson when the kernel is missing", () => {
    setPaChainTableForTests(null);
    const state = computeMlbBandState(feed(), 4.5, 5.5);
    expect(state!.model).toBe("poisson");
    expect(state!.fair).toBeGreaterThan(1.33);
  });

  it("memoized distribution reports sane run environment", () => {
    const table = loadPaChainTable(PATHS.mlbPaChainTransitions)!;
    const dist = paChainDistribution(table, {
      inning: 1,
      half: "top",
      outs: 0,
      bases: "---",
      scoreAway: 0,
      scoreHome: 0,
    });
    const meanTotal = dist.meanExtraAway + dist.meanExtraHome;
    // Full game from first pitch: ~8-10 total runs on average.
    expect(meanTotal).toBeGreaterThan(7);
    expect(meanTotal).toBeLessThan(11);
  });
});

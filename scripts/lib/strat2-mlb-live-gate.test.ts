import { describe, expect, it } from "vitest";
import type { Candidate, MarketQuote } from "./monotonic-arb-core.js";
import type { FeedSnapshot } from "./state-feed-map.js";
import {
  computeStrat2State,
  computeStrat2SpreadState,
  isTerminalState,
  parseMlbInningsLeft,
  poissonDiffPInBand,
  poissonPInBand,
  resolveSpreadSide,
  setStrat2FeedForTests,
  strat2MlbApproval,
} from "./strat2-mlb-live-gate.js";

// Reference values computed with scripts/score_strat2_state.py (the validated
// shadow scorer); the TS port must agree with the Python model exactly.

function feed(overrides: Partial<FeedSnapshot> = {}): FeedSnapshot {
  return {
    source: "statsapi",
    feedId: "1",
    live: true,
    scoreHome: 2,
    scoreAway: 3,
    period: "Top 5",
    outs: 1,
    clock: null,
    status: "In Progress",
    rawScoreKey: "3-2|Top 5|1|In Progress",
    ...overrides,
  };
}

function quote(overrides: Partial<MarketQuote>): MarketQuote {
  return {
    eventSlug: "mlb-sea-tb-2026-07-12",
    eventTitle: "Mariners vs. Rays",
    marketId: "m1",
    ladderKey: "sports:mlb:mlb-sea-tb-2026-07-12:total:full-game",
    question: "Mariners vs. Rays: O/U 8.5",
    description: "",
    resolutionSource: "",
    strike: 8.5,
    direction: "above",
    startDate: null,
    endDate: null,
    liquidity: 100,
    yesTokenId: "yes1",
    noTokenId: "no1",
    yesBook: { tokenId: "yes1", bid: 0.5, bidSize: 50, ask: 0.55, askSize: 50, spread: 0.01, minOrderSize: 1 },
    noBook: { tokenId: "no1", bid: 0.4, bidSize: 50, ask: 0.5, askSize: 50, spread: 0.01, minOrderSize: 1 },
    ...overrides,
  };
}

function mlbCandidate(overrides: Partial<Candidate> = {}): Candidate {
  const broad = quote({ strike: 8.5, question: "Mariners vs. Rays: O/U 8.5" });
  const narrow = quote({
    strike: 9.5,
    question: "Mariners vs. Rays: O/U 9.5",
    noBook: { tokenId: "no-narrow", bid: 0.55, bidSize: 50, ask: 0.6, askSize: 50, spread: 0.01, minOrderSize: 1 },
  });
  return {
    foundAt: new Date().toISOString(),
    asset: "MLB",
    eventSlug: "mlb-sea-tb-2026-07-12",
    eventTitle: "Mariners vs. Rays",
    packageId: "pkg",
    direction: "above",
    broad,
    narrow,
    packageCost: 1.15,
    lockedEdge: -0.15,
    availableSize: 100,
    maxSpread: 0.01,
    minLiquidity: 100,
    jackpotPayoutPerShare: 2,
    eligible: true,
    rejectionReasons: [],
    ...overrides,
  };
}

function mlbSpreadCandidate(overrides: Partial<Candidate> = {}): Candidate {
  const ladderKey = "sports:mlb:mlb-sea-tb-2026-07-12:spread:full-game:seattle-mariners";
  const broad = quote({
    strike: 1.5,
    question: "Spread: Seattle Mariners (-1.5)",
    ladderKey,
    eventTitle: "Seattle Mariners vs. Tampa Bay Rays",
  });
  const narrow = quote({
    strike: 3.5,
    question: "Spread: Seattle Mariners (-3.5)",
    ladderKey,
    eventTitle: "Seattle Mariners vs. Tampa Bay Rays",
    noBook: { tokenId: "no-narrow", bid: 0.55, bidSize: 50, ask: 0.6, askSize: 50, spread: 0.01, minOrderSize: 1 },
  });
  return mlbCandidate({
    eventTitle: "Seattle Mariners vs. Tampa Bay Rays",
    broad,
    narrow,
    packageCost: 1.10,
    ...overrides,
  });
}

describe("poissonPInBand parity with Python", () => {
  it("matches score_strat2_state for current=7 band (8.5, 9.5] lam=0.48*4.5*1.8", () => {
    expect(poissonPInBand(7, 8.5, 9.5, 0.48 * 4.5 * 1.8)).toBeCloseTo(0.15484085873095085, 12);
  });

  it("matches score_strat2_state for current=3 band (7.5, 9.5] lam=0.48*6*1.8", () => {
    expect(poissonPInBand(3, 7.5, 9.5, 0.48 * 6.0 * 1.8)).toBeCloseTo(0.325992067325524, 12);
  });

  it("returns 0 when the band is already passed", () => {
    expect(poissonPInBand(10, 8.5, 9.5, 2)).toBe(0);
  });
});

describe("poissonDiffPInBand (Skellam / spread)", () => {
  it("is 1 when margin is already locked in-band and no runs remain", () => {
    expect(poissonDiffPInBand(2, 1.5, 3.5, 0, 0)).toBe(1);
  });

  it("is 0 when margin is already above the band and no runs remain", () => {
    expect(poissonDiffPInBand(4, 1.5, 3.5, 0, 0)).toBe(0);
  });

  it("matches the mirrored underdog band under swapped lambdas", () => {
    const p = poissonDiffPInBand(0, 1.5, 2.5, 0.5, 0.5);
    expect(p).toBeGreaterThan(0.04);
    expect(p).toBeLessThan(0.25);
    const mirrored = poissonDiffPInBand(0, -2.5, -1.5, 0.5, 0.5);
    expect(mirrored).toBeCloseTo(p, 12);
  });
});

describe("resolveSpreadSide", () => {
  it("maps the named team to away/home from the title", () => {
    expect(
      resolveSpreadSide(
        "Seattle Mariners vs. Tampa Bay Rays",
        "sports:mlb:x:spread:full-game:seattle-mariners",
      ),
    ).toBe("away");
    expect(
      resolveSpreadSide(
        "Seattle Mariners vs. Tampa Bay Rays",
        "sports:mlb:x:spread:full-game:tampa-bay-rays",
      ),
    ).toBe("home");
  });

  it("rejects first-half ladders", () => {
    expect(
      resolveSpreadSide(
        "Seattle Mariners vs. Tampa Bay Rays",
        "sports:mlb:x:spread:first-half:seattle-mariners",
      ),
    ).toBeNull();
  });
});

describe("parseMlbInningsLeft parity with Python", () => {
  it("top 5th with 1 out", () => {
    expect(parseMlbInningsLeft(feed())).toBeCloseTo(4.833333333333333, 12);
  });

  it("tied bottom 9th includes expected extras", () => {
    expect(parseMlbInningsLeft(feed({ period: "Bottom 9", outs: 0, scoreHome: 4, scoreAway: 4 }))).toBeCloseTo(1.25, 12);
  });

  it("walk-off state (home leading bottom 9th) is over", () => {
    expect(parseMlbInningsLeft(feed({ period: "Bottom 9", outs: 1, scoreHome: 5, scoreAway: 4 }))).toBe(0);
  });

  it("tied top 9th", () => {
    expect(parseMlbInningsLeft(feed({ period: "Top 9", outs: 0, scoreHome: 4, scoreAway: 4 }))).toBeCloseTo(1.75, 12);
  });

  it("final is 0", () => {
    expect(parseMlbInningsLeft(feed({ status: "Final", live: false })))
      .toBe(0);
  });
});

describe("terminal-state exclusion", () => {
  it("late innings are terminal", () => {
    expect(isTerminalState(1.25, 8, 8.5, 9.5)).toBe(true);
  });

  it("inside the band with little time is terminal", () => {
    expect(isTerminalState(2.5, 9, 8.5, 9.5)).toBe(true);
  });

  it("mid-game is not terminal", () => {
    expect(isTerminalState(4.83, 5, 8.5, 9.5)).toBe(false);
  });
});

describe("computeStrat2State", () => {
  it("builds calibrated state from a live feed", () => {
    const state = computeStrat2State(feed(), 8.5, 9.5);
    expect(state).not.toBeNull();
    expect(state!.currentTotal).toBe(5);
    expect(state!.lambda).toBeCloseTo(0.48 * 4.833333333333333 * 1.8, 9);
    expect(state!.fair).toBeCloseTo(1 + state!.pMiddle, 12);
  });

  it("returns null without a score", () => {
    expect(computeStrat2State(feed({ scoreHome: null }), 8.5, 9.5)).toBeNull();
  });
});

describe("strat2MlbApproval gate", () => {
  it("is inert unless ARB_DAEMON_STRAT2_MLB_LIVE=1", () => {
    // Default test env does not set the flag, so the gate must return null
    // (meaning: no strat2 opinion; normal gates fully apply).
    expect(strat2MlbApproval(mlbCandidate())).toBeNull();
    setStrat2FeedForTests("mlb-sea-tb-2026-07-12", feed());
    expect(strat2MlbApproval(mlbCandidate())).toBeNull();
  });
});

describe("strat2MlbApproval gate (enabled)", () => {
  // STRAT2_MLB_LIVE is evaluated at module load, so enable the flag and
  // re-import a fresh module instance (same pattern as soccer-event-best-cost).
  async function enabledGate() {
    process.env.ARB_DAEMON_STRAT2_MLB_LIVE = "1";
    const { vi } = await import("vitest");
    vi.resetModules();
    return import("./strat2-mlb-live-gate.js");
  }

  it("approves a live mid-game package with sufficient model edge", async () => {
    const gate = await enabledGate();
    // Top 5, 1 out, total 5, band (8.5, 9.5]. Gate fair now comes from the
    // PA-chain MC (Poisson only as fallback); cost=1.05 leaves ≥8¢ edge.
    const { computeMlbBandState } = await import("./mlb-pa-chain.js");
    const chain = computeMlbBandState(feed(), 8.5, 9.5);
    gate.setStrat2FeedForTests("mlb-sea-tb-2026-07-12", feed());
    const approval = gate.strat2MlbApproval(mlbCandidate({ packageCost: 1.05 }));
    expect(approval?.ok).toBe(true);
    expect(approval?.state?.model).toBe("pa_chain");
    expect(approval?.reason).toContain("model=pa_chain");
    expect(approval?.state?.pMiddle).toBeCloseTo(chain!.pMiddle, 12);
  });

  it("rejects when the edge margin is not met", async () => {
    const gate = await enabledGate();
    gate.setStrat2FeedForTests("mlb-sea-tb-2026-07-12", feed());
    const approval = gate.strat2MlbApproval(mlbCandidate({ packageCost: 1.12 }));
    expect(approval?.ok).toBe(false);
    expect(approval?.reason).toMatch(/strat2_insufficient_edge/);
  });

  it("rejects terminal game states", async () => {
    const gate = await enabledGate();
    gate.setStrat2FeedForTests(
      "mlb-sea-tb-2026-07-12",
      feed({ period: "Bottom 9", outs: 0, scoreHome: 4, scoreAway: 4, rawScoreKey: "4-4|Bottom 9|0|In Progress" }),
    );
    const approval = gate.strat2MlbApproval(mlbCandidate({ packageCost: 1.01 }));
    expect(approval?.ok).toBe(false);
    expect(approval?.reason).toMatch(/strat2_terminal_state/);
  });

  it("rejects non-live games and missing feeds", async () => {
    const gate = await enabledGate();
    expect(gate.strat2MlbApproval(mlbCandidate())?.reason).toBe("strat2_no_fresh_feed");
    gate.setStrat2FeedForTests("mlb-sea-tb-2026-07-12", feed({ live: false, status: "Scheduled" }));
    expect(gate.strat2MlbApproval(mlbCandidate())?.reason).toBe("strat2_game_not_live");
  });

  it("ignores spreads unless ARB_DAEMON_STRAT2_MLB_SPREADS=1", async () => {
    delete process.env.ARB_DAEMON_STRAT2_MLB_SPREADS;
    const gate = await enabledGate();
    gate.setStrat2FeedForTests("mlb-sea-tb-2026-07-12", feed());
    expect(gate.strat2MlbApproval(mlbSpreadCandidate())).toBeNull();
  });

  it("approves a spread middle when spreads are enabled", async () => {
    process.env.ARB_DAEMON_STRAT2_MLB_SPREADS = "1";
    const gate = await enabledGate();
    // Away SEA 3, home TB 2 → SEA margin = +1. Band (1.5, 3.5].
    // Gate fair is the PA-chain margin distribution.
    const { computeMlbSpreadBandState } = await import("./mlb-pa-chain.js");
    const state = computeMlbSpreadBandState(feed(), 1.5, 3.5, "away");
    expect(state).not.toBeNull();
    expect(state!.currentMargin).toBe(1);
    expect(state!.marketType).toBe("spread");
    expect(state!.model).toBe("pa_chain");
    gate.setStrat2FeedForTests("mlb-sea-tb-2026-07-12", feed());
    // Price below fair so edge clears the 8¢ margin.
    const cost = Math.max(0.5, state!.fair - 0.10);
    const approval = gate.strat2MlbApproval(mlbSpreadCandidate({ packageCost: cost }));
    expect(approval?.ok).toBe(true);
    expect(approval?.reason).toMatch(/strat2_spread_edge/);
    expect(approval?.state?.pMiddle).toBeCloseTo(state!.pMiddle, 12);
  });
});

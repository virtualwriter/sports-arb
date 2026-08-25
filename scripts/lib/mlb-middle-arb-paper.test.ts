import { describe, expect, it } from "vitest";
import type { Candidate, MarketQuote } from "./monotonic-arb-core.js";
import type { SportsBacktestShape } from "./soccer-backtest-live-gate.js";
import { buildMlbMiddleArbEventCache } from "./mlb-middle-arb-cache.js";
import { MlbMiddleArbPaperSidecar } from "./mlb-middle-arb-paper.js";
import type { FeedSnapshot } from "./state-feed-map.js";

function quote(overrides: Partial<MarketQuote>): MarketQuote {
  return {
    eventSlug: "mlb-sea-tb-2026-07-16",
    eventTitle: "Mariners vs. Rays",
    marketId: "m1",
    ladderKey: "sports:mlb:mlb-sea-tb-2026-07-16:total:full-game",
    question: "Mariners vs. Rays: O/U 7.5",
    description: "",
    resolutionSource: "",
    strike: 7.5,
    direction: "above",
    startDate: null,
    endDate: null,
    liquidity: 100,
    yesTokenId: "yes1",
    noTokenId: "no1",
    yesBook: { tokenId: "yes1", bid: 0, bidSize: 0, ask: 0, askSize: 0, spread: 0.01, minOrderSize: 1 },
    noBook: { tokenId: "no1", bid: 0, bidSize: 0, ask: 0, askSize: 0, spread: 0.01, minOrderSize: 1 },
    ...overrides,
  };
}

function totalCandidate(lo: number, hi: number): Candidate {
  const broad = quote({
    marketId: `t${lo}`,
    strike: lo,
    question: `Mariners vs. Rays: O/U ${lo}`,
    yesTokenId: `yes-t${lo}`,
    noTokenId: `no-t${lo}`,
  });
  const narrow = quote({
    marketId: `t${hi}`,
    strike: hi,
    question: `Mariners vs. Rays: O/U ${hi}`,
    yesTokenId: `yes-t${hi}`,
    noTokenId: `no-t${hi}`,
    yesBook: { tokenId: `yes-t${hi}`, bid: 0, bidSize: 0, ask: 0, askSize: 0, spread: 0.01, minOrderSize: 1 },
    noBook: { tokenId: `no-t${hi}`, bid: 0, bidSize: 0, ask: 0, askSize: 0, spread: 0.01, minOrderSize: 1 },
  });
  return {
    foundAt: new Date().toISOString(),
    asset: "MLB",
    eventSlug: "mlb-sea-tb-2026-07-16",
    eventTitle: "Mariners vs. Rays",
    packageId: `pkg-${lo}-${hi}`,
    direction: "above",
    broad,
    narrow,
    packageCost: 0,
    lockedEdge: 1,
    availableSize: 0,
    maxSpread: 0,
    minLiquidity: 0,
    jackpotPayoutPerShare: 2,
    eligible: true,
    rejectionReasons: [],
  };
}

describe("mlb middle arb paper", () => {
  it("ranks edge gain on score and tracks book reprice window", async () => {
    const shapes = new Map<string, SportsBacktestShape>([
      [
        "MLB|game_total|7.5-8.5|w1",
        {
          asset: "MLB",
          marketType: "game_total",
          lineFamily: "7.5-8.5",
          middleWidth: 1,
          resolved: 20,
          middleRate: 0.25,
          worstRoiPct: 2,
          worstAvgCost: 1.4,
          maxLiveCost: 1.4,
        },
      ],
    ]);

    const feed0: FeedSnapshot = {
      source: "statsapi",
      feedId: "1",
      live: true,
      scoreHome: 4,
      scoreAway: 3,
      period: "Bottom 8",
      outs: 2,
      clock: null,
      status: "Live",
      rawScoreKey: "3-4",
      runnersOn: 2,
      onFirst: true,
      onSecond: true,
      onThird: false,
      battingSide: "home",
    };

    const cache = buildMlbMiddleArbEventCache({
      eventSlug: "mlb-sea-tb-2026-07-16",
      eventTitle: "Mariners vs. Rays",
      candidates: [totalCandidate(7.5, 8.5)],
      shapes,
      feed: feed0,
    });
    expect(cache.packages).toHaveLength(1);
    expect(cache.packages[0]!.state?.pMiddle).toBeGreaterThan(0);

    const rows: Record<string, unknown>[] = [];
    const paper = new MlbMiddleArbPaperSidecar({
      eventSlug: "mlb-sea-tb-2026-07-16",
      eventTitle: "Mariners vs. Rays",
      emit: (r) => rows.push(r),
    });
    paper.hydrateForTests(cache, { away: 3, home: 4 });
    expect(paper.stats.paPriorsLoaded).toBe(true);

    // Force an RBI menu emit with runners/outs for PA weighting.
    (paper as any).emitRbiMenu("test", true);
    const menu = rows.find((r) => r.kind === "mlb_paper_rbi_menu") as any;
    expect(menu).toBeTruthy();
    expect(menu.bases).toBe("12-");
    expect(menu.paPrior?.source).toBe("outs_bases");
    expect(menu.branches?.length).toBeGreaterThanOrEqual(1);
    expect(menu.branches[0]).toMatchObject({
      pWeight: expect.any(Number),
      pRbi: expect.any(Number),
    });
    const weightSum = menu.branches.reduce((s: number, b: any) => s + b.pWeight, 0);
    expect(weightSum).toBeCloseTo(1, 5);
    expect(menu.topExpectedEdgePa?.length).toBeGreaterThanOrEqual(1);
    expect(menu.confirmPath).toBe("strat2_on_realized_rbi");

    const t0 = Date.now();
    paper.onLadder({ market: "total_7.5", klass: "total", side: "yes", bestAsk: 0.42, bestAskSize: 80, t: t0 });
    paper.onLadder({ market: "total_8.5", klass: "total", side: "no", bestAsk: 0.72, bestAskSize: 80, t: t0 });
    paper.onLadder({ market: "moneyline", klass: "moneyline", side: "yes", bestAsk: 0.5, bestAskSize: 100, t: t0 });

    // Late game: total 7→8 lands in (7.5, 8.5] with little baseball left → P jumps
    paper.onPmScore("4-4", "Bottom 8", t0 + 10);
    await new Promise((r) => setTimeout(r, 150));

    // Book starts moving
    paper.onLadder({ market: "moneyline", klass: "moneyline", side: "yes", bestAsk: 0.55, bestAskSize: 100, t: t0 + 80 });
    paper.onLadder({ market: "total_7.5", klass: "total", side: "yes", bestAsk: 0.48, bestAskSize: 40, t: t0 + 120 });
    paper.onLadder({ market: "total_8.5", klass: "total", side: "no", bestAsk: 0.75, bestAskSize: 40, t: t0 + 200 });

    await new Promise((r) => setTimeout(r, 50));
    paper.end();

    const scoreEvent = rows.find((r) => r.kind === "mlb_paper_score_event") as any;
    expect(scoreEvent).toBeTruthy();
    expect(scoreEvent.scoreAway).toBe(4);
    expect(scoreEvent.scoreHome).toBe(4);
    expect(scoreEvent.rbiDelta).toBe(1);
    expect(scoreEvent.paCalibration).toMatchObject({
      bases: "12-",
      realizedRbiDelta: 1,
      pWeightRealized: expect.any(Number),
      priorSource: "outs_bases",
    });
    expect(scoreEvent.confirmPath).toBe("strat2_on_realized_rbi");
    expect(scoreEvent.topEdgeGains?.length).toBeGreaterThanOrEqual(1);
    expect(scoreEvent.topEdgeGains[0]).toMatchObject({
      lineFamily: "7.5-8.5",
      preEdge: expect.any(Number),
      postEdge: expect.any(Number),
      edgeGain: expect.any(Number),
    });
    // Parallel delta-anchored track is always logged (may be empty if no shock ≥ 8¢).
    expect(Array.isArray(scoreEvent.wouldFireDelta)).toBe(true);
    for (const d of scoreEvent.wouldFireDelta) {
      expect(d.track).toBe("delta_anchored");
      expect(d.deltaEdge).toBeCloseTo(d.edgeGain, 5);
      expect(d.screenOk).toBe(true);
    }

    const window = rows.find((r) => r.kind === "mlb_paper_score_window") as any;
    expect(window).toBeTruthy();
    expect(window.bookSignals.moneylineFirstMoveMs).toBeTypeOf("number");
    expect(window.bookSignals.totalFirstMoveMs).toBeTypeOf("number");
    expect(window.watched[0].path.length).toBeGreaterThanOrEqual(1);
    expect(window.watched[0].timeCostPlus3cMs).toBeTypeOf("number");
  });

  it("drops pm_score jumps > 4 runs (cross-game feed, CLE@CIN 2026-07-28)", () => {
    const rows: Record<string, unknown>[] = [];
    const paper = new MlbMiddleArbPaperSidecar({
      eventSlug: "mlb-cle-cin-2026-07-28",
      eventTitle: "Guardians vs. Reds",
      emit: (r) => rows.push(r),
    });
    const cache = buildMlbMiddleArbEventCache({
      eventSlug: "mlb-cle-cin-2026-07-28",
      eventTitle: "Guardians vs. Reds",
      candidates: [totalCandidate(7.5, 8.5)],
      shapes: new Map(),
      feed: null,
    });
    paper.hydrateForTests(cache, { away: 6, home: 5 });

    // pm following the other DH game reports 0-1 → jump 10, must be dropped.
    paper.onPmScore("0-1", "Bot 2nd", Date.now());
    expect(rows.find((r) => r.kind === "mlb_paper_score")).toBeUndefined();
    expect(paper.getScoreState()).toMatchObject({ away: 6, home: 5 });

    // A plausible one-event move still passes.
    paper.onPmScore("6-6", "Bottom 9", Date.now());
    expect(paper.getScoreState()).toMatchObject({ away: 6, home: 6 });
  });

  it("freezes score events once the game is Final", () => {
    const rows: Record<string, unknown>[] = [];
    const paper = new MlbMiddleArbPaperSidecar({
      eventSlug: "mlb-cle-cin-2026-07-28",
      eventTitle: "Guardians vs. Reds",
      emit: (r) => rows.push(r),
    });
    const cache = buildMlbMiddleArbEventCache({
      eventSlug: "mlb-cle-cin-2026-07-28",
      eventTitle: "Guardians vs. Reds",
      candidates: [totalCandidate(7.5, 8.5)],
      shapes: new Map(),
      feed: null,
    });
    paper.hydrateForTests(cache, { away: 6, home: 5 });
    (paper as any).gameFinal = true;

    // Non-statsapi feeds are dropped outright — even small moves.
    paper.onPmScore("6-6", "Bottom 9", Date.now());
    const ignored = rows.find((r) => r.kind === "mlb_paper_score_ignored") as any;
    expect(ignored).toMatchObject({ source: "pm_score", reason: "game_final" });
    expect(paper.getScoreState()).toMatchObject({ away: 6, home: 5 });
    expect(rows.find((r) => r.kind === "mlb_paper_score_event")).toBeUndefined();
  });

  it("treats an emptied ask side as a missing quote, not zero cost", () => {
    const paper = new MlbMiddleArbPaperSidecar({
      eventSlug: "mlb-sea-tb-2026-07-16",
      eventTitle: "Mariners vs. Rays",
      emit: () => {},
    });
    const tob = (paper as any).tob as Map<string, unknown>;

    const t = Date.now();
    paper.onLadder({ market: "total_4.5", klass: "total", side: "yes", bestAsk: 0.99, bestAskSize: 2000, t });
    expect(tob.has("total_4.5:yes")).toBe(true);

    // Locked winner: every resting ask gets pulled → book empties.
    paper.onLadder({ market: "total_4.5", klass: "total", side: "yes", bestAsk: 0, bestAskSize: 0, t: t + 10 });
    expect(tob.has("total_4.5:yes")).toBe(false);

    // Positive ask with zero size is also unbuyable → missing.
    paper.onLadder({ market: "total_4.5", klass: "total", side: "yes", bestAsk: 0.99, bestAskSize: 0, t: t + 20 });
    expect(tob.has("total_4.5:yes")).toBe(false);

    // A real quote restores the entry.
    paper.onLadder({ market: "total_4.5", klass: "total", side: "yes", bestAsk: 0.99, bestAskSize: 50, t: t + 30 });
    expect(tob.has("total_4.5:yes")).toBe(true);
  });
});

describe("game-state heartbeat and shadow scan", () => {
  function earlyFeed(period: string): FeedSnapshot {
    return {
      source: "statsapi",
      feedId: "1",
      live: true,
      scoreHome: 2,
      scoreAway: 2,
      period,
      outs: 1,
      clock: null,
      status: "In Progress",
      rawScoreKey: "2-2",
      runnersOn: 0,
      onFirst: false,
      onSecond: false,
      onThird: false,
      battingSide: "away",
    };
  }

  function setup(period = "3rd Inning") {
    const cache = buildMlbMiddleArbEventCache({
      eventSlug: "mlb-sea-tb-2026-07-16",
      eventTitle: "Mariners vs. Rays",
      candidates: [totalCandidate(7.5, 8.5)],
      shapes: new Map(),
      feed: earlyFeed(period),
    });
    const rows: Record<string, unknown>[] = [];
    const paper = new MlbMiddleArbPaperSidecar({
      eventSlug: "mlb-sea-tb-2026-07-16",
      eventTitle: "Mariners vs. Rays",
      emit: (r) => rows.push(r),
    });
    paper.hydrateForTests(cache, { away: 2, home: 2 });
    return { paper, rows };
  }

  const beat = (paper: MlbMiddleArbPaperSidecar) => (paper as any).emitGameState();
  const kinds = (rows: Record<string, unknown>[], k: string) => rows.filter((r) => r.kind === k);

  it("samples inning, score and the near rung even when nothing is happening", () => {
    const { paper, rows } = setup();
    paper.onKalshiLadder({
      market: "total_4.5", side: "yes", bestAsk: 0.82, bestAskSize: 40, bestBid: 0.8, ticker: "T-4",
    });
    beat(paper);

    const state = kinds(rows, "mlb_game_state")[0] as any;
    expect(state).toMatchObject({
      inning: 3,
      curTotal: 4,
      nearLine: 4.5,
      nearAsk: 0.82,
      nearSize: 40,
      nearBid: 0.8,
      feedSource: "statsapi_poll",
    });
  });

  it("flags a cheap near rung without placing anything", () => {
    const { paper, rows } = setup();
    paper.onKalshiLadder({
      market: "total_4.5", side: "yes", bestAsk: 0.82, bestAskSize: 40, bestBid: 0.8, ticker: "T-4",
    });
    beat(paper);

    const shadow = kinds(rows, "mlb_over_softball_shadow")[0] as any;
    expect(shadow).toMatchObject({ line: 4.5, ask: 0.82, askSize: 40, inning: 3 });
    expect(shadow.spread).toBeCloseTo(0.02, 6);
    expect(shadow.modelEdge).toBeGreaterThan(0);
    expect(kinds(rows, "mlb_over_softball_order")).toHaveLength(0);
  });

  it("does not repeat a rung that just sits there, but reports a real move", () => {
    const { paper, rows } = setup();
    const quoteAt = (ask: number) => paper.onKalshiLadder({
      market: "total_4.5", side: "yes", bestAsk: ask, bestAskSize: 40, bestBid: ask - 0.02, ticker: "T-4",
    });
    quoteAt(0.82);
    beat(paper);
    beat(paper);
    beat(paper);
    expect(kinds(rows, "mlb_over_softball_shadow")).toHaveLength(1);
    // Heartbeats keep coming regardless — that is the clock.
    expect(kinds(rows, "mlb_game_state")).toHaveLength(3);

    quoteAt(0.7);
    beat(paper);
    expect(kinds(rows, "mlb_over_softball_shadow")).toHaveLength(2);
  });

  it("stays quiet on a rich rung, a thin one, and past the fifth", () => {
    const rich = setup();
    rich.paper.onKalshiLadder({
      market: "total_4.5", side: "yes", bestAsk: 0.96, bestAskSize: 900, bestBid: 0.95, ticker: "T-4",
    });
    beat(rich.paper);
    expect(kinds(rich.rows, "mlb_over_softball_shadow")).toHaveLength(0);

    const thin = setup();
    thin.paper.onKalshiLadder({
      market: "total_4.5", side: "yes", bestAsk: 0.7, bestAskSize: 2, bestBid: 0.68, ticker: "T-4",
    });
    beat(thin.paper);
    expect(kinds(thin.rows, "mlb_over_softball_shadow")).toHaveLength(0);

    const late = setup("8th Inning");
    late.paper.onKalshiLadder({
      market: "total_4.5", side: "yes", bestAsk: 0.7, bestAskSize: 400, bestBid: 0.68, ticker: "T-4",
    });
    beat(late.paper);
    expect(kinds(late.rows, "mlb_over_softball_shadow")).toHaveLength(0);
    // The clock still ticks in the 8th; only the shadow is gated on inning.
    expect((kinds(late.rows, "mlb_game_state")[0] as any).inning).toBe(8);
  });

  it("ignores a rung more than one run above the current total", () => {
    const { paper, rows } = setup();
    paper.onKalshiLadder({
      market: "total_6.5", side: "yes", bestAsk: 0.6, bestAskSize: 500, bestBid: 0.58, ticker: "T-6",
    });
    beat(paper);
    expect((kinds(rows, "mlb_game_state")[0] as any).nearLine).toBeNull();
    expect(kinds(rows, "mlb_over_softball_shadow")).toHaveLength(0);
  });
});

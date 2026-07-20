import { describe, expect, it } from "vitest";
import {
  buildActiveRbiBranches,
  possibleRbiDeltas,
  rbiDeltaFromScoreChange,
  scoreAfterRbiDelta,
} from "./mlb-rbi-branches.js";
import { countRunnersOn } from "./state-feed-map.js";
import {
  buildMlbMiddleArbEventCache,
  huntListForRbiDelta,
} from "./mlb-middle-arb-cache.js";
import type { Candidate, MarketQuote } from "./monotonic-arb-core.js";
import type { SportsBacktestShape } from "./soccer-backtest-live-gate.js";
import type { FeedSnapshot } from "./state-feed-map.js";

describe("mlb RBI branches", () => {
  it("maps runners-on to possible RBI deltas", () => {
    expect(possibleRbiDeltas(0)).toEqual([1]);
    expect(possibleRbiDeltas(1)).toEqual([1, 2]);
    expect(possibleRbiDeltas(2)).toEqual([1, 2, 3]);
    expect(possibleRbiDeltas(3)).toEqual([1, 2, 3, 4]);
  });

  it("counts bases from offense", () => {
    expect(countRunnersOn({ first: { id: 1 }, second: null, third: { id: 3 } }).runnersOn).toBe(2);
    expect(countRunnersOn({}).runnersOn).toBe(0);
  });

  it("builds batting-side score counterfactuals", () => {
    const branches = buildActiveRbiBranches({
      scoreAway: 2,
      scoreHome: 1,
      battingSide: "away",
      runnersOn: 1,
    });
    expect(branches.map((b) => b.rbiDelta)).toEqual([1, 2]);
    expect(branches[1]).toMatchObject({ scoreAway: 4, scoreHome: 1 });
    expect(scoreAfterRbiDelta({
      scoreAway: 2,
      scoreHome: 1,
      battingSide: "home",
      rbiDelta: 3,
    })).toEqual({ scoreAway: 2, scoreHome: 4 });
  });

  it("matches confirmed score change to RBI delta", () => {
    expect(rbiDeltaFromScoreChange(2, 1, 4, 1)).toBe(2);
    expect(rbiDeltaFromScoreChange(2, 1, 2, 2)).toBe(1);
  });

  it("hunt list prefers packages for the confirmed delta", () => {
    const shapes = new Map<string, SportsBacktestShape>([
      [
        "MLB|game_total|5.5-8.5|w3",
        {
          asset: "MLB",
          marketType: "game_total",
          lineFamily: "5.5-8.5",
          middleWidth: 3,
          resolved: 20,
          middleRate: 0.3,
          worstRoiPct: 2,
          worstAvgCost: 1.4,
          maxLiveCost: 1.4,
        },
      ],
    ]);
    const q = (lo: number, hi: number): Candidate => {
      const broad: MarketQuote = {
        eventSlug: "mlb-sea-tb-2026-07-16",
        eventTitle: "Mariners vs. Rays",
        marketId: `t${lo}`,
        ladderKey: "sports:mlb:mlb-sea-tb-2026-07-16:total:full-game",
        question: `O/U ${lo}`,
        description: "",
        resolutionSource: "",
        strike: lo,
        direction: "above",
        startDate: null,
        endDate: null,
        liquidity: 1,
        yesTokenId: `y${lo}`,
        noTokenId: `n${lo}`,
        yesBook: { tokenId: `y${lo}`, bid: 0, bidSize: 0, ask: 0, askSize: 0, spread: 0.01, minOrderSize: 1 },
        noBook: { tokenId: `n${lo}`, bid: 0, bidSize: 0, ask: 0, askSize: 0, spread: 0.01, minOrderSize: 1 },
      };
      const narrow = { ...broad, marketId: `t${hi}`, strike: hi, yesTokenId: `y${hi}`, noTokenId: `n${hi}` };
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
    };
    const feed: FeedSnapshot = {
      source: "statsapi",
      feedId: "1",
      live: true,
      scoreHome: 2,
      scoreAway: 2,
      period: "Top 5",
      outs: 0,
      clock: null,
      status: "Live",
      rawScoreKey: "2-2",
      runnersOn: 2,
      battingSide: "away",
    };
    const cache = buildMlbMiddleArbEventCache({
      eventSlug: "mlb-sea-tb-2026-07-16",
      eventTitle: "Mariners vs. Rays",
      candidates: [q(5.5, 8.5)],
      shapes,
      feed,
    });
    expect(cache.rbiBranches.map((b) => b.rbiDelta)).toEqual([1, 2, 3]);
    expect(cache.branchEvalsByPackage["pkg-5.5-8.5"]?.length).toBe(3);
    const hunt = huntListForRbiDelta(cache, 2, { "pkg-5.5-8.5": 1.2 });
    expect(hunt[0]?.rbiDelta).toBe(2);
    expect(hunt[0]?.edge).toBeTypeOf("number");
  });
});

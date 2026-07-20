import { describe, expect, it } from "vitest";
import {
  kalshiSpreadMiddleCandidatesFromRungs,
  kalshiTotalMiddleCandidatesFromRungs,
  mergeMlbPaperCandidates,
} from "./mlb-middle-arb-cache.js";
import type { Candidate, MarketQuote } from "./monotonic-arb-core.js";

function pmStub(lo: number, hi: number): Candidate {
  const q = (strike: number): MarketQuote => ({
    eventSlug: "mlb-nym-phi-2026-07-18",
    eventTitle: "Mets vs Phillies",
    marketId: `pm-${strike}`,
    ladderKey: "sports:mlb:mlb-nym-phi-2026-07-18:total:full-game",
    question: `O/U ${strike}`,
    description: "",
    resolutionSource: "",
    strike,
    direction: "above",
    startDate: null,
    endDate: null,
    liquidity: 1,
    yesTokenId: `y${strike}`,
    noTokenId: `n${strike}`,
    yesBook: { tokenId: `y${strike}`, bid: 0, bidSize: 0, ask: 0, askSize: 0, spread: 0.01, minOrderSize: 1 },
    noBook: { tokenId: `n${strike}`, bid: 0, bidSize: 0, ask: 0, askSize: 0, tick: 0.01, minOrderSize: 1 },
  });
  return {
    foundAt: "t",
    asset: "MLB",
    eventSlug: "mlb-nym-phi-2026-07-18",
    eventTitle: "Mets vs Phillies",
    packageId: `pm::${lo}-${hi}`,
    direction: "above",
    broad: q(lo),
    narrow: q(hi),
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

describe("kalshi total middle candidates", () => {
  it("builds all rung pairs and respects maxWidth", () => {
    const all = kalshiTotalMiddleCandidatesFromRungs({
      eventSlug: "mlb-nym-phi-2026-07-18",
      eventTitle: "Mets vs Phillies",
      foundAt: "t",
      rungs: [3.5, 4.5, 5.5],
      maxWidth: null,
    });
    expect(all).toHaveLength(3); // 3.5-4.5, 3.5-5.5, 4.5-5.5
    const capped = kalshiTotalMiddleCandidatesFromRungs({
      eventSlug: "mlb-nym-phi-2026-07-18",
      eventTitle: "Mets vs Phillies",
      foundAt: "t",
      rungs: [3.5, 4.5, 5.5],
      maxWidth: 1,
    });
    expect(capped.map((c) => `${c.broad.strike}-${c.narrow.strike}`).sort()).toEqual([
      "3.5-4.5",
      "4.5-5.5",
    ]);
  });

  it("prefers PM package when same ladder band overlaps Kalshi", () => {
    const kalshi = kalshiTotalMiddleCandidatesFromRungs({
      eventSlug: "mlb-nym-phi-2026-07-18",
      eventTitle: "Mets vs Phillies",
      foundAt: "t",
      rungs: [8.5, 9.5, 10.5],
      maxWidth: null,
    });
    const merged = mergeMlbPaperCandidates([pmStub(8.5, 9.5)], kalshi);
    expect(merged).toHaveLength(3);
    const band85 = merged.find((c) => c.broad.strike === 8.5 && c.narrow.strike === 9.5);
    expect(band85?.packageId).toBe("pm::8.5-9.5");
  });

  it("builds per-team Kalshi spread middle pairs", () => {
    const cands = kalshiSpreadMiddleCandidatesFromRungs({
      eventSlug: "mlb-nym-phi-2026-07-18",
      eventTitle: "New York Mets vs. Philadelphia Phillies",
      foundAt: "t",
      rungs: [
        { ticker: "A-PHI2", teamAbbr: "PHI", teamKey: "philadelphia-phillies", strike: 1.5 },
        { ticker: "A-PHI3", teamAbbr: "PHI", teamKey: "philadelphia-phillies", strike: 2.5 },
        { ticker: "A-PHI4", teamAbbr: "PHI", teamKey: "philadelphia-phillies", strike: 3.5 },
        { ticker: "A-NYM2", teamAbbr: "NYM", teamKey: "new-york-mets", strike: 1.5 },
        { ticker: "A-NYM3", teamAbbr: "NYM", teamKey: "new-york-mets", strike: 2.5 },
      ],
      maxWidth: null,
    });
    // PHI C(3,2)=3 + NYM C(2,2)=1 = 4
    expect(cands).toHaveLength(4);
    expect(cands.every((c) => c.broad.ladderKey.includes(":spread:full-game:"))).toBe(true);
    expect(cands.some((c) => c.broad.ladderKey.endsWith(":philadelphia-phillies"))).toBe(true);
    expect(cands.some((c) => c.broad.ladderKey.endsWith(":new-york-mets"))).toBe(true);
  });

  it("does not let PM F5/team-total bands clobber Kalshi full-game totals", () => {
    const kalshi = kalshiTotalMiddleCandidatesFromRungs({
      eventSlug: "mlb-nym-phi-2026-07-18",
      eventTitle: "Mets vs Phillies",
      foundAt: "t",
      rungs: [3.5, 4.5],
      maxWidth: null,
    });
    const f5 = pmStub(3.5, 4.5);
    f5.broad = {
      ...f5.broad,
      ladderKey: "sports:mlb:mlb-nym-phi-2026-07-18:team-total:full-game:1st-5-innings",
    };
    f5.narrow = { ...f5.narrow, ladderKey: f5.broad.ladderKey };
    f5.packageId = "pm-f5::3.5-4.5";
    const merged = mergeMlbPaperCandidates([f5], kalshi);
    expect(merged).toHaveLength(2);
    expect(merged.some((c) => c.packageId.startsWith("mlb-nym-phi") && c.packageId.includes("kalshi"))).toBe(true);
    expect(merged.some((c) => c.packageId === "pm-f5::3.5-4.5")).toBe(true);
  });
});

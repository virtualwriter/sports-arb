import { describe, expect, it } from "vitest";
import { evaluatePair, isNestedLadderEvent, polymarketAssetForSlug, structuralMarketQuote, type Book, type GammaEvent } from "./monotonic-arb-core.js";
import { evaluateSportsStrategy } from "./sports-strategy.js";

function book(overrides: Partial<Book> = {}): Book {
  return {
    tokenId: "token",
    bid: 0.4,
    bidSize: 100,
    ask: 0.5,
    askSize: 100,
    spread: 0.01,
    minOrderSize: 1,
    ...overrides,
  };
}

describe("monotonic sports parsing", () => {
  it("builds a tennis total-games middle from low YES and high NO", () => {
    const event: GammaEvent = {
      slug: "wta-dodin-sawangk-2026-06-25",
      title: "Wimbledon, Qualification WTA: Oceane Dodin vs Mananchaya Sawangkaew",
      markets: [],
    };
    const low = structuralMarketQuote(event, {
      id: "low",
      question: "Dodin vs. Sawangkaew: Match O/U 21.5",
      outcomes: JSON.stringify(["Over", "Under"]),
      clobTokenIds: JSON.stringify(["low-over", "low-under"]),
      active: true,
    });
    const high = structuralMarketQuote(event, {
      id: "high",
      question: "Dodin vs. Sawangkaew: Match O/U 23.5",
      outcomes: JSON.stringify(["Over", "Under"]),
      clobTokenIds: JSON.stringify(["high-over", "high-under"]),
      active: true,
    });

    expect(polymarketAssetForSlug(event.slug!)).toBe("WOMENS_TENNIS");
    expect(low?.ladderKey).toBe("sports:womens-tennis:wta-dodin-sawangk-2026-06-25:total:match");
    expect(high?.ladderKey).toBe(low?.ladderKey);
    expect(low?.strike).toBe(21.5);
    expect(high?.strike).toBe(23.5);

    low!.yesBook = book({ tokenId: "low-over", ask: 0.55, askSize: 20 });
    high!.noBook = book({ tokenId: "high-under", ask: 0.54, askSize: 20 });
    const candidate = evaluatePair(
      {
        host: "https://clob.polymarket.com",
        gammaApi: "https://gamma-api.polymarket.com",
        fetchTimeoutMs: 1000,
        marketConcurrency: 1,
        eventConcurrency: 1,
        allowedAssets: new Set(["WOMENS_TENNIS"]),
        minEdge: -1,
        maxSpread: 0.1,
        minLiquidity: 0,
        minAvailableShares: 1,
      },
      "WOMENS_TENNIS",
      low!,
      high!,
      "2026-06-24T00:00:00.000Z",
    );

    expect(candidate.eligible).toBe(true);
    expect(candidate.broad.marketId).toBe("low");
    expect(candidate.narrow.marketId).toBe("high");
    expect(candidate.packageCost).toBeCloseTo(1.09);

    const decision = evaluateSportsStrategy(candidate);
    expect(decision.marketType).toBe("match_total");
    expect(decision.liveEligible).toBe(false);
    expect(decision.gateFailures).toContain("adapter_shadow_only");
  });

  it("does not mix tennis set-game totals into full-match total capture", () => {
    const event: GammaEvent = {
      slug: "wta-dodin-sawangk-2026-06-25",
      title: "Wimbledon, Qualification WTA: Oceane Dodin vs Mananchaya Sawangkaew",
      markets: [],
    };

    expect(structuralMarketQuote(event, {
      id: "set-games",
      question: "Dodin vs. Sawangkaew: Set 1 Games O/U 8.5",
      outcomes: JSON.stringify(["Over", "Under"]),
      clobTokenIds: JSON.stringify(["over", "under"]),
      active: true,
    })).toBeNull();
  });
});

describe("polymarketAssetForSlug", () => {
  it("classifies existing core asset ladders", () => {
    expect(polymarketAssetForSlug("what-price-will-bitcoin-hit-in-june-2026")).toBe("BTC");
    expect(polymarketAssetForSlug("what-price-will-ethereum-hit-in-june-2026")).toBe("ETH");
    expect(polymarketAssetForSlug("what-price-will-solana-hit-before-2027")).toBe("SOL");
    expect(polymarketAssetForSlug("what-price-will-hyperliquid-hit-before-2027")).toBe("HYPE");
  });

  it("classifies finance and commodity special cases", () => {
    expect(polymarketAssetForSlug("spacex-ipo-closing-market-cap-above")).toBe("FINANCE");
    expect(polymarketAssetForSlug("gc-hit-jun-2026")).toBe("GOLD");
    expect(polymarketAssetForSlug("si-hit-jun-2026")).toBe("SILVER");
    expect(polymarketAssetForSlug("cl-over-under-jun-2026")).toBe("OIL");
    expect(polymarketAssetForSlug("amazon-market-cap-hit-2026")).toBe("AMZN");
  });

  it("classifies sports game ladders", () => {
    expect(polymarketAssetForSlug("nba-sas-nyk-2026-06-10")).toBe("NBA");
    expect(polymarketAssetForSlug("mlb-sea-bal-2026-06-09")).toBe("MLB");
    expect(polymarketAssetForSlug("atp-player-a-player-b-2026-06-25")).toBe("TENNIS");
    expect(polymarketAssetForSlug("wta-dodin-sawangk-2026-06-25")).toBe("WOMENS_TENNIS");
    expect(polymarketAssetForSlug("fifwc-can-bih-2026-06-12-more-markets")).toBe("SOCCER");
    expect(polymarketAssetForSlug("mls-sea-por-2026-06-20-more-markets")).toBe("SOCCER");
  });

  it("leaves unknown slugs unclassified", () => {
    expect(polymarketAssetForSlug("random-election-market")).toBeNull();
  });
});

describe("isNestedLadderEvent", () => {
  it("accepts hit, reach, dip, above, and NBA ladder forms", () => {
    expect(isNestedLadderEvent("what-price-will-bitcoin-hit-in-june-2026")).toBe(true);
    expect(isNestedLadderEvent("what-price-will-solana-reach-before-2027")).toBe(true);
    expect(isNestedLadderEvent("ethereum-dip-below-in-june-2026")).toBe(true);
    expect(isNestedLadderEvent("spacex-ipo-closing-market-cap-above")).toBe(true);
    expect(isNestedLadderEvent("nba-nyk-sas-2026-06-05")).toBe(true);
    expect(isNestedLadderEvent("mlb-sea-bal-2026-06-09")).toBe(true);
    expect(isNestedLadderEvent("wta-dodin-sawangk-2026-06-25")).toBe(true);
    expect(isNestedLadderEvent("fifwc-can-bih-2026-06-12-more-markets")).toBe(true);
  });

  it("rejects settlement, final trading day, over-under, and range markets", () => {
    expect(isNestedLadderEvent("cl-over-under-jun-2026")).toBe(false);
    expect(isNestedLadderEvent("oil-final-trading-day-june-2026")).toBe(false);
    expect(isNestedLadderEvent("bitcoin-settle-june-2026")).toBe(false);
    expect(isNestedLadderEvent("btc-range-90000-100000")).toBe(false);
    expect(isNestedLadderEvent("btc-price", "Will Bitcoin be $90,000 - $100,000?")).toBe(false);
  });
});

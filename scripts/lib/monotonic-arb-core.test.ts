import { describe, expect, it } from "vitest";
import {
  isNestedLadderEvent,
  polymarketAssetForSlug,
} from "./monotonic-arb-core.js";

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

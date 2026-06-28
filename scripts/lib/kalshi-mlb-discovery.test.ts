import { describe, expect, it } from "vitest";
import {
  buildTotalsCandidates,
  buildTotalsLadder,
  parseKalshiMarket,
} from "./kalshi-mlb-discovery.js";
import type { KalshiMarket } from "./kalshi-client.js";

function syntheticTotalsMarket(strike: number, yesAskCents: number, noAskCents: number): KalshiMarket {
  return {
    ticker: `KXMLB-25JUN26ARIBOS-T${strike}`,
    event_ticker: "KXMLBGAME-25JUN26ARIBOS",
    title: `ARI@BOS: Total runs over ${strike}?`,
    subtitle: `Over ${strike}`,
    yes_sub_title: `Over ${strike} runs`,
    no_sub_title: `Under ${strike} runs`,
    yes_bid: yesAskCents - 1,
    yes_ask: yesAskCents,
    no_bid: noAskCents - 1,
    no_ask: noAskCents,
    liquidity: 500,
    status: "open",
    cap_strike: strike,
  };
}

describe("parseKalshiMarket", () => {
  it("classifies total markets and extracts strike", () => {
    const parsed = parseKalshiMarket(syntheticTotalsMarket(7.5, 60, 42));
    expect(parsed.marketType).toBe("total");
    expect(parsed.strike).toBe(7.5);
    expect(parsed.side).toBe("over");
    expect(parsed.yesAsk).toBeCloseTo(0.6, 4);
    expect(parsed.noAsk).toBeCloseTo(0.42, 4);
  });

  it("handles already-dollarized prices", () => {
    const m = syntheticTotalsMarket(7.5, 60, 42);
    m.yes_ask = 0.6;
    m.no_ask = 0.42;
    const parsed = parseKalshiMarket(m);
    expect(parsed.yesAsk).toBeCloseTo(0.6, 4);
    expect(parsed.noAsk).toBeCloseTo(0.42, 4);
  });
});

describe("buildTotalsLadder + buildTotalsCandidates", () => {
  it("constructs a strike ladder from totals markets and emits two-leg middles", () => {
    const markets = [
      parseKalshiMarket(syntheticTotalsMarket(6.5, 75, 27)),
      parseKalshiMarket(syntheticTotalsMarket(7.5, 60, 42)),
      parseKalshiMarket(syntheticTotalsMarket(8.5, 42, 60)),
    ];
    const ladder = buildTotalsLadder(markets);
    expect(ladder).not.toBeNull();
    expect(ladder!.strikes.map((s) => s.strike)).toEqual([6.5, 7.5, 8.5]);

    const candidates = buildTotalsCandidates(ladder!, { maxWidth: 4 });
    // Pairs: (6.5,7.5), (6.5,8.5), (7.5,8.5)
    expect(candidates).toHaveLength(3);

    // (6.5,7.5): yes_ask broad=0.75, no_ask narrow=0.42 -> packageCost=1.17
    const narrowest = candidates.find((c) => c.broadStrike === 6.5 && c.narrowStrike === 7.5)!;
    expect(narrowest.packageCost).toBeCloseTo(1.17, 4);
    expect(narrowest.direction).toBe("above");
    expect(narrowest.packageId).toMatch(/^kalshi::KXMLBGAME-25JUN26ARIBOS::YES-.+\+NO-.+$/);

    // (7.5,8.5): yes_ask broad=0.60, no_ask narrow=0.60 -> packageCost=1.20
    const middle = candidates.find((c) => c.broadStrike === 7.5 && c.narrowStrike === 8.5)!;
    expect(middle.packageCost).toBeCloseTo(1.20, 4);
  });

  it("respects maxWidth limit", () => {
    const markets = [6.5, 7.5, 8.5, 9.5, 10.5].map((s, i) =>
      parseKalshiMarket(syntheticTotalsMarket(s, 80 - i * 10, 20 + i * 10)),
    );
    const ladder = buildTotalsLadder(markets)!;
    const candidates = buildTotalsCandidates(ladder, { maxWidth: 2 });
    // Allowed pairs (width<=2): (6.5,7.5),(6.5,8.5),(7.5,8.5),(7.5,9.5),(8.5,9.5),(8.5,10.5),(9.5,10.5) = 7
    expect(candidates.length).toBe(7);
    expect(candidates.every((c) => c.narrowStrike - c.broadStrike <= 2)).toBe(true);
  });
});

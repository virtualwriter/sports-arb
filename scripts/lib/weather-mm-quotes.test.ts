import { describe, expect, it } from "vitest";
import { fairFromReading } from "./weather-fair-value.js";
import {
  buildLadderQuotes,
  buildStrikeQuote,
  quoteModeForMinutesToClose,
} from "./weather-mm-quotes.js";

describe("weather MM quotes", () => {
  it("modes: normal → widen ≤10m → pull ≤3m", () => {
    expect(quoteModeForMinutesToClose(30)).toBe("normal");
    expect(quoteModeForMinutesToClose(10)).toBe("widen");
    expect(quoteModeForMinutesToClose(5)).toBe("widen");
    expect(quoteModeForMinutesToClose(3)).toBe("pull");
    expect(quoteModeForMinutesToClose(0)).toBe("pull");
  });

  it("quotes two-sided around fair in normal mode", () => {
    const fair = fairFromReading({ readingF: 75, source: "metar51", anchor51F: 75 });
    const q = buildStrikeQuote({
      ticker: "T",
      floor: 74.99,
      fair,
      minutesToClose: 40,
      params: { halfSpread: 0.02 },
    });
    expect(q.mode).toBe("normal");
    expect(q.yesBid).not.toBeNull();
    expect(q.yesAsk).not.toBeNull();
    expect(q.yesAsk!).toBeGreaterThan(q.yesBid!);
    expect(q.mid).toBeGreaterThan(0.5);
    expect(q.mid).toBeLessThan(0.9);
  });

  it("widens in last 10 minutes and pulls in last 3", () => {
    const fair = fairFromReading({ readingF: 75, source: "synoptic" });
    const w = buildStrikeQuote({
      ticker: "T",
      floor: 74.99,
      fair,
      minutesToClose: 8,
      params: { halfSpread: 0.02, widenHalfSpread: 0.08 },
    });
    expect(w.mode).toBe("widen");
    expect((w.yesAsk ?? 0) - (w.yesBid ?? 0)).toBeGreaterThanOrEqual(0.15);

    const p = buildStrikeQuote({
      ticker: "T",
      floor: 74.99,
      fair,
      minutesToClose: 2,
    });
    expect(p.mode).toBe("pull");
    expect(p.yesBid).toBeNull();
    expect(p.yesAsk).toBeNull();
  });

  it("inventory long YES shades mid down", () => {
    const fair = fairFromReading({ readingF: 75, source: "metar51" });
    const flat = buildStrikeQuote({ ticker: "T", floor: 74.99, fair, inventoryYes: 0 });
    const long = buildStrikeQuote({
      ticker: "T",
      floor: 74.99,
      fair,
      inventoryYes: 50,
      params: { invSkewPerContract: 0.001 },
    });
    expect(long.mid).toBeLessThan(flat.mid);
  });

  it("builds a ladder", () => {
    const fair = fairFromReading({ readingF: 80, source: "metar51", anchor51F: 80 });
    const qs = buildLadderQuotes({
      strikes: [
        { ticker: "A", floor: 78.99 },
        { ticker: "B", floor: 79.99 },
        { ticker: "C", floor: 80.99 },
      ],
      fair,
      minutesToClose: 25,
    });
    expect(qs).toHaveLength(3);
    expect(qs[0]!.pYes).toBeGreaterThan(qs[1]!.pYes);
    expect(qs[1]!.pYes).toBeGreaterThan(qs[2]!.pYes);
  });
});

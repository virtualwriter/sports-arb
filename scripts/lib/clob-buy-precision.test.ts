import { describe, expect, it } from "vitest";
import {
  clobBuyAmountValid,
  precisionSafeBuyShares,
} from "../polymarket-real-monotonic-executor.js";

describe("clob marketable BUY precision", () => {
  it("rejects the BAL@HOU hedge that failed live (6.1 @ 0.93)", () => {
    expect(clobBuyAmountValid(0.93, 6.1)).toBe(false);
    expect(6.1 * 0.93).toBeCloseTo(5.673, 6);
  });

  it("resizes that fill to a cent-exact hedge", () => {
    expect(precisionSafeBuyShares(0.93, 1, 6.1)).toBe(6);
    expect(clobBuyAmountValid(0.93, 6)).toBe(true);
    expect(6 * 0.93).toBeCloseTo(5.58, 6);
  });

  it("keeps sizes that are already valid", () => {
    expect(precisionSafeBuyShares(0.5, 1, 6.1)).toBe(6.1);
    expect(clobBuyAmountValid(0.5, 6.1)).toBe(true);
  });

  it("enforces taker share decimals ≤ 4", () => {
    expect(clobBuyAmountValid(0.5, 1.00001)).toBe(false);
  });
});

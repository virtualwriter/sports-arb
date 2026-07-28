import { describe, expect, it } from "vitest";
import {
  minPackageSharesForMarketableBuys,
  minSharesForMarketableBuyUsd,
} from "./pm-softball-exec.js";

describe("pm softball min marketable notional", () => {
  it("requires ≥12.5 shares at 8¢ to clear $1 (Lucknow failure shape)", () => {
    expect(minSharesForMarketableBuyUsd(0.08, 1)).toBe(12.5);
    expect(10 * 0.08).toBeCloseTo(0.8, 6);
    expect(12.5 * 0.08).toBeCloseTo(1.0, 6);
  });

  it("package floor is driven by the cheapest leg", () => {
    expect(
      minPackageSharesForMarketableBuys(
        [{ price: 0.08 }, { price: 0.9 }],
        5,
        1,
      ),
    ).toBe(12.5);
  });

  it("still respects the per-order share floor when asks are expensive", () => {
    expect(
      minPackageSharesForMarketableBuys(
        [{ price: 0.45 }, { price: 0.5 }],
        5,
        1,
      ),
    ).toBe(5);
  });

  it("skips when touch size cannot clear the cheap-leg floor", () => {
    const need = minPackageSharesForMarketableBuys(
      [{ price: 0.08 }, { price: 0.9 }],
      5,
      1,
    );
    expect(10).toBeLessThan(need);
  });
});

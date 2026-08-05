import { describe, expect, it } from "vitest";
import {
  correctFairOnReadingChange,
  fairFromReading,
  pInteger,
  pYesAboveFloor,
} from "./weather-fair-value.js";

describe("weather fair value", () => {
  it("integer bins sum near 1 around μ", () => {
    const mu = 74.2;
    const sig = 0.7;
    let sum = 0;
    for (let k = 70; k <= 78; k++) sum += pInteger(mu, sig, k);
    expect(sum).toBeGreaterThan(0.98);
    expect(sum).toBeLessThanOrEqual(1.0001);
  });

  it("pYes rises as floor drops below μ", () => {
    const mu = 75;
    const sig = 0.7;
    const high = pYesAboveFloor(mu, sig, 73.99); // 74+
    const mid = pYesAboveFloor(mu, sig, 74.99); // 75+
    const low = pYesAboveFloor(mu, sig, 75.99); // 76+
    expect(high).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(low);
    // μ exactly on an integer: mass on that bin + right tail ⇒ pYes(floor=μ-0.01) > 0.5
    expect(mid).toBeGreaterThan(0.5);
    expect(mid).toBeLessThan(0.9);
  });

  it("anchors from :51 and corrects on reading change", () => {
    const anchor = fairFromReading({
      readingF: 78.1,
      source: "metar51",
      anchor51F: 78.1,
    });
    expect(anchor.mu).toBeCloseTo(78.1);
    expect(anchor.anchor51F).toBe(78.1);

    const { state: same, changed: no } = correctFairOnReadingChange(anchor, 78.12, "synoptic");
    expect(no).toBe(false);
    expect(same).toBe(anchor);

    const { state: next, changed: yes } = correctFairOnReadingChange(anchor, 76.5, "synoptic");
    expect(yes).toBe(true);
    expect(next.mu).toBeCloseTo(76.5);
    expect(next.source).toBe("synoptic");
    expect(next.anchor51F).toBe(78.1);
  });
});

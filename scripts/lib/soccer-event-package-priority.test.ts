import { describe, expect, it } from "vitest";
import type { Candidate } from "./monotonic-arb-core.js";
import {
  isBetterSoccerEventPackage,
  pickCheapestSoccerPackagesByEvent,
  shouldDeferSoccerPackage,
} from "./soccer-event-package-priority.js";

function soccerCandidate(strikes: [number, number], cost: number, packageId: string): Candidate {
  const [broad, narrow] = strikes;
  return {
    packageId,
    eventSlug: "fifwc-test-2026-07-01-more-markets",
    asset: "SOCCER",
    packageCost: cost,
    broad: { strike: broad } as Candidate["broad"],
    narrow: { strike: narrow } as Candidate["narrow"],
  } as Candidate;
}

describe("soccer-event-package-priority", () => {
  it("prefers lower cost on the same event", () => {
    const cheap = soccerCandidate([3.5, 5.5], 1.21, "a");
    const dear = soccerCandidate([3.5, 6.5], 1.23, "b");
    expect(isBetterSoccerEventPackage(cheap, dear)).toBe(true);
    expect(isBetterSoccerEventPackage(dear, cheap)).toBe(false);
  });

  it("prefers narrower middle when cost ties", () => {
    const narrow = soccerCandidate([3.5, 5.5], 1.22, "a");
    const wide = soccerCandidate([3.5, 6.5], 1.22, "b");
    expect(isBetterSoccerEventPackage(narrow, wide)).toBe(true);
  });

  it("picks one package per event from a batch", () => {
    const items = [
      { key: "wide", candidate: soccerCandidate([3.5, 6.5], 1.23, "wide") },
      { key: "cheap", candidate: soccerCandidate([3.5, 5.5], 1.21, "cheap") },
    ];
    const picked = pickCheapestSoccerPackagesByEvent(items);
    expect(picked).toHaveLength(1);
    expect(picked[0]?.key).toBe("cheap");
  });

  it("defers a dearer package when a cheaper same-family sibling exists", () => {
    const items = [
      { key: "cheap", candidate: soccerCandidate([3.5, 5.5], 1.21, "cheap") },
      { key: "dear", candidate: soccerCandidate([3.5, 5.5], 1.23, "dear") },
    ];
    const defer = shouldDeferSoccerPackage(items[1]!.candidate, "dear", items);
    expect(defer?.defer).toBe(true);
    expect(defer?.cheaperKey).toBe("cheap");
    expect(defer?.cheaperCost).toBe(1.21);
  });

  it("does not defer across different line families on the same event", () => {
    const items = [
      { key: "cheap", candidate: soccerCandidate([3.5, 5.5], 1.21, "cheap") },
      { key: "dear", candidate: soccerCandidate([3.5, 6.5], 1.23, "dear") },
    ];
    expect(shouldDeferSoccerPackage(items[1]!.candidate, "dear", items)).toBeNull();
  });
});

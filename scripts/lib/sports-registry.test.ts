import { describe, expect, it } from "vitest";
import { adapterForSlug, SPORT_ADAPTERS } from "./sports-registry.js";

describe("sports registry", () => {
  it("keeps MLB and SOCCER live-enabled and new sports shadow/discovery first", () => {
    expect(adapterForSlug("mlb-yankees-red-sox")?.mode).toBe("live_enabled");
    expect(adapterForSlug("mls-miami-atlanta")?.mode).toBe("live_enabled");
    expect(adapterForSlug("wnba-aces-liberty")?.mode).toBe("shadow_only");
    expect(adapterForSlug("tennis-player-a-player-b")?.mode).toBe("shadow_only");
    expect(adapterForSlug("golf-masters-winner")?.mode).toBe("discovery_only");
  });

  it("uses distinct adapter versions", () => {
    const versions = new Set(SPORT_ADAPTERS.map((adapter) => adapter.adapterVersion));
    expect(versions.size).toBe(SPORT_ADAPTERS.length);
  });
});

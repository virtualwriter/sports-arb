import { describe, expect, it } from "vitest";
import { rememberMarketShard, shardForTicker } from "./kalshi-client.js";

// Kalshi splits matching across shards and keeps collateral per shard, so an
// order sent to the wrong one is rejected: `market_not_found` when the market
// lives elsewhere, `user_not_found` when the shard holds no funds. Getting
// this map wrong costs the whole print.
describe("market shard registry", () => {
  it("hands back what it was told", () => {
    rememberMarketShard("KXMLBTOTAL-26AUG311805SFATL-9", 3);
    expect(shardForTicker("KXMLBTOTAL-26AUG311805SFATL-9")).toBe(3);
  });

  it("asks Kalshi to auto-route a ticker it has never seen", () => {
    // -1 is what the engine sent before shards existed, so an unknown ticker
    // degrades to the old behaviour rather than guessing shard 0 and being
    // told the market does not exist.
    expect(shardForTicker("KXMLBTOTAL-NEVER-SEEN-7")).toBe(-1);
  });

  it("keeps shard 0 distinct from unknown", () => {
    rememberMarketShard("KXHIGHNY-26AUG31-B80", 0);
    expect(shardForTicker("KXHIGHNY-26AUG31-B80")).toBe(0);
  });

  it("ignores a market that arrived without a shard", () => {
    rememberMarketShard("KXMLBTOTAL-26AUG311805SFATL-4", undefined);
    expect(shardForTicker("KXMLBTOTAL-26AUG311805SFATL-4")).toBe(-1);
  });

  it("takes the newer shard when a market is re-read", () => {
    rememberMarketShard("KXTENNIS-REASSIGNED", 0);
    rememberMarketShard("KXTENNIS-REASSIGNED", 3);
    expect(shardForTicker("KXTENNIS-REASSIGNED")).toBe(3);
  });

  it("does not record a blank ticker", () => {
    rememberMarketShard("", 3);
    expect(shardForTicker("")).toBe(-1);
  });
});

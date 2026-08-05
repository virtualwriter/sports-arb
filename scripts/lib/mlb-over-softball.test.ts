import { describe, expect, it } from "vitest";
import {
  earlyOverCategories,
  kalshiYesTobFromPaperMap,
  parseMlbInning,
  planAskWalk,
  selectEarlyOverSoftball,
  yesAskLevelsFromNoBids,
} from "./mlb-over-softball.js";

describe("parseMlbInning", () => {
  it("parses common period strings", () => {
    expect(parseMlbInning("Top 5th")).toBe(5);
    expect(parseMlbInning("Bot 8")).toBe(8);
    expect(parseMlbInning("5th Inning")).toBe(5);
    expect(parseMlbInning(null)).toBeNull();
  });
});

describe("earlyOverCategories", () => {
  it("tags multi_run_early for 2+ runs in innings 1–6", () => {
    expect(earlyOverCategories(4, 2, 0.91)).toEqual(["multi_run_early"]);
    expect(earlyOverCategories(7, 2, 0.91)).toEqual([]);
    expect(earlyOverCategories(4, 1, 0.91)).toEqual([]);
  });

  it("tags cheap_over_early for ask in [0.50, 0.80) early", () => {
    expect(earlyOverCategories(3, 1, 0.65)).toEqual(["cheap_over_early"]);
    expect(earlyOverCategories(3, 1, 0.8)).toEqual([]);
    expect(earlyOverCategories(3, 1, 0.49)).toEqual([]);
  });

  it("can attach both cats", () => {
    expect(earlyOverCategories(2, 3, 0.72)).toEqual([
      "multi_run_early",
      "cheap_over_early",
    ]);
  });
});

describe("selectEarlyOverSoftball", () => {
  const tob = new Map([
    [6.5, { ask: 0.92, askSize: 50, ticker: "T-6.5" }],
    [7.5, { ask: 0.71, askSize: 20, ticker: "T-7.5" }],
    [8.5, { ask: 0.55, askSize: 10, ticker: "T-8.5" }],
  ]);

  it("picks cheapest next-line over and early cats", () => {
    const c = selectEarlyOverSoftball({
      inning: 3,
      runsDelta: 2,
      curTotal: 7,
      kalshiYesTob: tob,
    });
    expect(c).toMatchObject({
      line: 7.5,
      ask: 0.71,
      ticker: "T-7.5",
      cats: ["multi_run_early", "cheap_over_early"],
    });
  });

  it("returns null when next-line ask is not an early softball", () => {
    const c = selectEarlyOverSoftball({
      inning: 3,
      runsDelta: 1,
      curTotal: 6,
      kalshiYesTob: tob, // next line 6.5 @ 0.92 — not cheap, not multi-run
    });
    expect(c).toBeNull();
  });

  it("returns null for late innings even if ask is cheap", () => {
    const c = selectEarlyOverSoftball({
      inning: 8,
      runsDelta: 1,
      curTotal: 8,
      kalshiYesTob: tob,
    });
    expect(c).toBeNull();
  });

  it("skips asks outside (0.05, 0.95)", () => {
    const locked = new Map([[7.5, { ask: 0.97, askSize: 100, ticker: "T-7.5" }]]);
    expect(
      selectEarlyOverSoftball({
        inning: 2,
        runsDelta: 2,
        curTotal: 7,
        kalshiYesTob: locked,
      }),
    ).toBeNull();
  });
});

describe("kalshiYesTobFromPaperMap", () => {
  it("extracts yes total rungs with ticker", () => {
    const paper = new Map([
      ["total_7.5:yes", { ask: 0.7, askSize: 5, t: 1, ticker: "KXMLB-7.5" }],
      ["total_7.5:no", { ask: 0.3, askSize: 5, t: 1, ticker: "KXMLB-7.5" }],
      ["total_8.5:yes", { ask: 0.5, askSize: 2, t: 1 }], // no ticker → drop
    ]);
    const m = kalshiYesTobFromPaperMap(paper);
    expect([...m.entries()]).toEqual([
      [7.5, { ask: 0.7, askSize: 5, ticker: "KXMLB-7.5", t: 1 }],
    ]);
  });
});

describe("planAskWalk", () => {
  it("walks to 2x TOB size within maxAsk", () => {
    const levels = yesAskLevelsFromNoBids(
      [[0.16, 10], [0.15, 50], [0.14, 16], [0.13, 21], [0.11, 34]],
      0.84,
      10,
    );
    // yes asks: 0.84, 0.85, 0.86, 0.87, 0.89
    const walk = planAskWalk({
      tobAsk: 0.84,
      tobSize: 10,
      askLevels: levels,
      maxAsk: 0.94,
      maxContracts: 25,
      maxUsd: 25,
      tobMult: 2,
    });
    expect(walk.targetSize).toBe(20);
    expect(walk.count).toBe(20);
    expect(walk.limitPrice).toBeLessThanOrEqual(0.86);
    expect(walk.vwap).toBeLessThan(0.86);
  });

  it("stops at maxAsk even if 2x TOB not reached", () => {
    const walk = planAskWalk({
      tobAsk: 0.92,
      tobSize: 3,
      askLevels: [[0.92, 3], [0.93, 3], [0.94, 8], [0.95, 31]],
      maxAsk: 0.94,
      maxContracts: 25,
      maxUsd: 25,
      tobMult: 2,
    });
    expect(walk.count).toBe(6); // 2x tob = 6
    expect(walk.limitPrice).toBe(0.93);
  });
});

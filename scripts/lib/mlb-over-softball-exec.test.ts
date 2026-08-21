import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeMlbOverSoftball,
  resetMlbOverSoftballExecForTests,
} from "./mlb-over-softball-exec.js";
import type { MlbOverSoftballCandidate } from "./mlb-over-softball.js";

afterEach(() => {
  resetMlbOverSoftballExecForTests();
  delete process.env.MLB_OVER_SOFTBALL_LIVE;
});

function ctxAt(
  inning: number,
  ask: number,
): { slug: string; t0: number; scoreAway: number; scoreHome: number; source: string; candidate: MlbOverSoftballCandidate } {
  return {
    slug: `mlb-a-b-2026-08-13-inn${inning}`,
    t0: 1,
    scoreAway: 4,
    scoreHome: 1,
    source: "bwin_score",
    candidate: {
      line: 5.5,
      ask,
      askSize: 40,
      ticker: `T-inn${inning}`,
      cats: ["multi_run_early" as const],
      curTotal: 5,
      inning,
      runsDelta: 2,
    },
  };
}

describe("executeMlbOverSoftball shadow", () => {
  it("shadows without LIVE and dedupes score key", async () => {
    const rows: Record<string, unknown>[] = [];
    const { configureMlbOverSoftballExec } = await import("./mlb-over-softball-exec.js");
    configureMlbOverSoftballExec({
      client: null,
      emit: (r) => rows.push(r),
    });
    const ctx = {
      slug: "mlb-a-b-2026-08-03",
      t0: 1,
      scoreAway: 2,
      scoreHome: 1,
      source: "bwin_score",
      candidate: {
        line: 4.5,
        ask: 0.72,
        askSize: 40,
        ticker: "T-4.5",
        cats: ["multi_run_early" as const, "cheap_over_early" as const],
        curTotal: 4,
        inning: 3,
        runsDelta: 2,
      },
    };
    expect(await executeMlbOverSoftball(ctx)).toBe("shadow");
    expect(await executeMlbOverSoftball(ctx)).toBe("skipped");
    expect(rows[0]?.kind).toBe("mlb_over_softball_signal");
    expect(rows[0]?.live).toBe(false);
  });
});

describe("edge-scaled sizing", () => {
  afterEach(() => {
    delete process.env.MLB_OVER_SOFTBALL_SIZE_FULL_EDGE;
    vi.resetModules();
  });

  async function fireAndReadOrder(inning: number, ask: number, size: number) {
    vi.resetModules();
    const mod = await import("./mlb-over-softball-exec.js");
    const rows: Record<string, unknown>[] = [];
    mod.configureMlbOverSoftballExec({
      client: {
        createOrderV2: async () => ({ fill_count: "0" }),
      } as never,
      emit: (r) => rows.push(r),
    });
    const ctx = ctxAt(inning, ask);
    ctx.candidate.askSize = size;
    ctx.candidate.askLevels = [[ask, size]];
    await mod.executeMlbOverSoftball(ctx);
    return rows.find((r) => r.kind === "mlb_over_softball_order");
  }

  it("risks less on a thin edge than on a fat one", async () => {
    process.env.MLB_OVER_SOFTBALL_LIVE = "1";
    // inn5 prior is 0.975, so 86c is a fat ~+10.7c and 90c a thin ~+6.9c.
    const fat = await fireAndReadOrder(5, 0.86, 500);
    const thin = await fireAndReadOrder(5, 0.9, 500);
    expect(fat).toBeTruthy();
    expect(thin).toBeTruthy();
    const fatCt = Number(fat?.count);
    const thinCt = Number(thin?.count);
    expect(thinCt).toBeGreaterThan(0);
    expect(thinCt).toBeLessThan(fatCt);
  });

  it("never sends a print at or below break-even", async () => {
    process.env.MLB_OVER_SOFTBALL_LIVE = "1";
    process.env.MLB_OVER_SOFTBALL_INN4_MAX_ASK = "0.99";
    vi.resetModules();
    const mod = await import("./mlb-over-softball-exec.js");
    const rows: Record<string, unknown>[] = [];
    mod.configureMlbOverSoftballExec({
      client: { createOrderV2: async () => ({ fill_count: "0" }) } as never,
      emit: (r) => rows.push(r),
    });
    // inn4 prior is 0.90, so 90c is negative once fees are paid.
    const ctx = ctxAt(4, 0.9);
    ctx.candidate.askLevels = [[0.9, 500]];
    ctx.candidate.askSize = 500;
    await mod.executeMlbOverSoftball(ctx);
    expect(rows.find((r) => r.kind === "mlb_over_softball_order")).toBeUndefined();
    expect(rows.find((r) => r.kind === "mlb_over_softball_skip")?.reason).toBe("no_edge");
    delete process.env.MLB_OVER_SOFTBALL_INN4_MAX_ASK;
  });
});

describe("retry after a skip", () => {
  afterEach(() => {
    delete process.env.MLB_OVER_SOFTBALL_MAX_ATTEMPTS;
    vi.resetModules();
  });

  it("re-looks at the same score after a price skip, then stops", async () => {
    process.env.MLB_OVER_SOFTBALL_LIVE = "1";
    process.env.MLB_OVER_SOFTBALL_MAX_ATTEMPTS = "3";
    vi.resetModules();
    const mod = await import("./mlb-over-softball-exec.js");
    const rows: Record<string, unknown>[] = [];
    mod.configureMlbOverSoftballExec({ client: null, emit: (r) => rows.push(r) });

    // inn4 at 91¢ is turned away on price; the score key must stay open so a
    // cheaper requote seconds later still gets a look.
    const ctx = ctxAt(4, 0.91);
    await mod.executeMlbOverSoftball(ctx);
    await mod.executeMlbOverSoftball(ctx);
    const skips = rows.filter((r) => r.kind === "mlb_over_softball_skip");
    expect(skips.length).toBe(2);
    expect(skips[1]?.reason).toBe("ask_above_inning_max");

    // ...but not forever.
    await mod.executeMlbOverSoftball(ctx);
    await mod.executeMlbOverSoftball(ctx);
    expect(rows.filter((r) => r.kind === "mlb_over_softball_skip").length).toBe(3);
  });
});

describe("deep-strike fallback", () => {
  afterEach(() => {
    delete process.env.MLB_OVER_SOFTBALL_DEEP_MIN_EDGE;
    vi.resetModules();
  });

  function deepAt(inning: number, line: number, ask: number) {
    return {
      line,
      ask,
      askSize: 40,
      ticker: `T-deep-${line}`,
      cats: ["multi_run_early" as const],
      curTotal: line - 1.5,
      inning,
      runsDelta: 2,
      runsNeeded: 2,
    };
  }

  it("steps up a rung when the near line is gated on price", async () => {
    process.env.MLB_OVER_SOFTBALL_LIVE = "1";
    vi.resetModules();
    const mod = await import("./mlb-over-softball-exec.js");
    const rows: Record<string, unknown>[] = [];
    mod.configureMlbOverSoftballExec({ client: null, emit: (r) => rows.push(r) });

    // ATL@MIN shape: near line 93¢ hits the late-high gate, rung above is 86¢.
    const near = { ...ctxAt(5, 0.93).candidate, line: 6.5, curTotal: 6 };
    await mod.executeMlbOverSoftball({
      ...ctxAt(5, 0.93),
      candidate: near,
      deepCandidate: deepAt(5, 7.5, 0.86),
    });
    const sig = rows.find((r) => r.kind === "mlb_over_softball_signal");
    expect(sig?.line).toBe(7.5);
    expect(sig?.runsNeeded).toBe(2);
    expect(sig?.deepFrom).toBe("ask_above_max");
  });

  it("leaves the near line alone when it is not gated", async () => {
    process.env.MLB_OVER_SOFTBALL_LIVE = "1";
    vi.resetModules();
    const mod = await import("./mlb-over-softball-exec.js");
    const rows: Record<string, unknown>[] = [];
    mod.configureMlbOverSoftballExec({ client: null, emit: (r) => rows.push(r) });

    const near = { ...ctxAt(5, 0.86).candidate, line: 5.5, curTotal: 5 };
    await mod.executeMlbOverSoftball({
      ...ctxAt(5, 0.86),
      candidate: near,
      deepCandidate: deepAt(5, 6.5, 0.74),
    });
    const sig = rows.find((r) => r.kind === "mlb_over_softball_signal");
    expect(sig?.line).toBe(5.5);
    expect(sig?.deepFrom).toBeNull();
  });

  it("declines the rung above when its edge is too thin", async () => {
    process.env.MLB_OVER_SOFTBALL_LIVE = "1";
    vi.resetModules();
    const mod = await import("./mlb-over-softball-exec.js");
    const rows: Record<string, unknown>[] = [];
    mod.configureMlbOverSoftballExec({ client: null, emit: (r) => rows.push(r) });

    // CWS@CHC shape: near 90¢ blocked at inn4, rung above 89¢ is worse, not better.
    const near = { ...ctxAt(4, 0.9).candidate, line: 5.5, curTotal: 5 };
    await mod.executeMlbOverSoftball({
      ...ctxAt(4, 0.9),
      candidate: near,
      deepCandidate: deepAt(4, 6.5, 0.89),
    });
    const skip = rows.find((r) => r.kind === "mlb_over_softball_skip");
    expect(skip?.reason).toBe("ask_above_inning_max");
    expect(skip?.line).toBe(5.5);
  });
});

describe("inning-4 ask cap", () => {
  afterEach(() => {
    delete process.env.MLB_OVER_SOFTBALL_INN4_MAX_ASK;
    vi.resetModules();
  });

  it("stands inn4 down at 89¢ but lets inn5 through at the same price", async () => {
    process.env.MLB_OVER_SOFTBALL_LIVE = "1";
    process.env.MLB_OVER_SOFTBALL_INN4_MAX_ASK = "0.86";
    vi.resetModules();
    const mod = await import("./mlb-over-softball-exec.js");
    const rows: Record<string, unknown>[] = [];
    mod.configureMlbOverSoftballExec({ client: null, emit: (r) => rows.push(r) });

    expect(await mod.executeMlbOverSoftball(ctxAt(4, 0.89))).toBe("skipped");
    expect(await mod.executeMlbOverSoftball(ctxAt(5, 0.89))).toBe("skipped");

    const skips = rows.filter((r) => r.kind === "mlb_over_softball_skip");
    // inn4 is turned away on price; inn5 only stops for the absent client.
    expect(skips[0]?.reason).toBe("ask_above_inning_max");
    expect(skips[1]?.reason).toBe("no_client");
  });

  it("takes inn4 when it prints at or below the cap", async () => {
    process.env.MLB_OVER_SOFTBALL_LIVE = "1";
    process.env.MLB_OVER_SOFTBALL_INN4_MAX_ASK = "0.86";
    vi.resetModules();
    const mod = await import("./mlb-over-softball-exec.js");
    const rows: Record<string, unknown>[] = [];
    mod.configureMlbOverSoftballExec({ client: null, emit: (r) => rows.push(r) });

    await mod.executeMlbOverSoftball(ctxAt(4, 0.86));
    const skips = rows.filter((r) => r.kind === "mlb_over_softball_skip");
    expect(skips[0]?.reason).toBe("no_client");
  });
});

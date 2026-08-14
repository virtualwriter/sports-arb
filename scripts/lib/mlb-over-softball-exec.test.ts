import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeMlbOverSoftball,
  resetMlbOverSoftballExecForTests,
} from "./mlb-over-softball-exec.js";

afterEach(() => {
  resetMlbOverSoftballExecForTests();
  delete process.env.MLB_OVER_SOFTBALL_LIVE;
});

function ctxAt(inning: number, ask: number) {
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

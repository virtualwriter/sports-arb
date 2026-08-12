import { afterEach, describe, expect, it } from "vitest";
import {
  executeMlbOverSoftball,
  resetMlbOverSoftballExecForTests,
} from "./mlb-over-softball-exec.js";

afterEach(() => {
  resetMlbOverSoftballExecForTests();
  delete process.env.MLB_OVER_SOFTBALL_LIVE;
});

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

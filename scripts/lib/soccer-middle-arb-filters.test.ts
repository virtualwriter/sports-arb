import { describe, expect, it } from "vitest";
import {
  ENG_ARG_FILTERED_KEEPERS,
  screenSoccerMiddleArb,
  screenSoccerMiddleArbLegs,
  screenSoccerMiddleArbShock,
  screenSoccerMiddleArbT1Flip,
} from "./soccer-middle-arb-filters.js";

describe("soccer middle arb filters", () => {
  it("keeps the three ENG–ARG non-dust goal packages", () => {
    expect(ENG_ARG_FILTERED_KEEPERS).toHaveLength(3);

    const shock = { maxMlJumpAbs: 0.26, maxTotalMoveAbs: 0.04 };
    const cases = [
      { broadYesAsk: 0.2725, narrowNoAsk: 0.975, edgeAtCurrent: -0.15, edgeAtTPlus1: 0.67 },
      { broadYesAsk: 0.31, narrowNoAsk: 0.968, edgeAtCurrent: -0.02, edgeAtTPlus1: 0.28 },
      { broadYesAsk: 0.115, narrowNoAsk: 0.968, edgeAtCurrent: -0.05, edgeAtTPlus1: 0.11 },
    ];

    for (const c of cases) {
      expect(
        screenSoccerMiddleArb({
          legs: { broadYesAsk: c.broadYesAsk, narrowNoAsk: c.narrowNoAsk },
          shock,
          ev: { edgeAtCurrent: c.edgeAtCurrent, edgeAtTPlus1: c.edgeAtTPlus1 },
        }),
      ).toEqual({ ok: true, reason: "ok" });
    }
  });

  it("screens dust NO via max entry leg", () => {
    expect(
      screenSoccerMiddleArbLegs({ broadYesAsk: 0.31, narrowNoAsk: 0.999 }),
    ).toEqual({ ok: false, reason: "max_entry_leg" });
  });

  it("screens FT flicker (mag≈1, no totals move)", () => {
    expect(
      screenSoccerMiddleArbShock({ maxMlJumpAbs: 1.0, maxTotalMoveAbs: 0 }),
    ).toEqual({ ok: false, reason: "shock_ft_flicker" });
  });

  it("screens scare shocks without totals co-move", () => {
    expect(
      screenSoccerMiddleArbShock({ maxMlJumpAbs: 0.12, maxTotalMoveAbs: 0.01 }),
    ).toEqual({ ok: false, reason: "shock_total_move" });
  });

  it("requires T+1 flip (not already +EV)", () => {
    expect(
      screenSoccerMiddleArbT1Flip({ edgeAtCurrent: 0.05, edgeAtTPlus1: 0.2 }),
    ).toEqual({ ok: false, reason: "no_t1_flip" });
    expect(
      screenSoccerMiddleArbT1Flip({ edgeAtCurrent: -0.05, edgeAtTPlus1: 0.2 }),
    ).toEqual({ ok: true, reason: "ok" });
  });
});

/**
 * MLB middle-arb paper screens (score-triggered Strat2 lane).
 *
 * Reuses Strat2 dust / cost / edge / terminal rules. Unlike soccer, there is
 * no ML-shock / T+1 flip filter — trigger is a real score change + accurate P.
 */

export const MLB_MIDDLE_ARB_FILTERS_VERSION = "2026-07-15.1";

export const DUST_YES_ASK = 0.02;
export const DUST_NO_ASK = 0.98;
export const MAX_PACKAGE_COST = Number(process.env.ARB_DAEMON_STRAT2_MAX_COST ?? 1.55);
export const EDGE_MARGIN = Number(process.env.ARB_DAEMON_STRAT2_EDGE_MARGIN ?? 0.08);

/** How long after a score event to track edge/cost decay on PM books. */
export const POST_SCORE_TRACK_MS = Number(process.env.PLR_MLB_POST_SCORE_TRACK_MS ?? 15_000);

/** Sample path when cost moves by at least this much. */
export const PATH_COST_STEP = 0.01;

export type MlbMiddleArbLegQuotes = {
  broadYesAsk: number;
  narrowNoAsk: number;
};

export type MlbMiddleArbFilterReason =
  | "ok"
  | "dust_leg"
  | "cost_above_max"
  | "insufficient_edge"
  | "terminal_state"
  | "no_state"
  | "no_tob";

export type MlbMiddleArbFilterResult = {
  ok: boolean;
  reason: MlbMiddleArbFilterReason;
};

export function screenMlbMiddleArbLegs(legs: MlbMiddleArbLegQuotes): MlbMiddleArbFilterResult {
  if (legs.broadYesAsk <= DUST_YES_ASK || legs.narrowNoAsk >= DUST_NO_ASK) {
    return { ok: false, reason: "dust_leg" };
  }
  const cost = legs.broadYesAsk + legs.narrowNoAsk;
  if (cost >= MAX_PACKAGE_COST) {
    return { ok: false, reason: "cost_above_max" };
  }
  return { ok: true, reason: "ok" };
}

export function screenMlbMiddleArbEdge(
  fair: number,
  cost: number,
  edgeMargin: number = EDGE_MARGIN,
): MlbMiddleArbFilterResult {
  const edge = fair - cost;
  if (edge < edgeMargin) return { ok: false, reason: "insufficient_edge" };
  return { ok: true, reason: "ok" };
}
